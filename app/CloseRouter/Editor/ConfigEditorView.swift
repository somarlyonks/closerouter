import SwiftUI

struct ConfigEditorView: View {
    enum SaveState {
        case idle
        case saving
        case saved(String)
        case error(String)
    }

    @State private var text: String = ""
    @State private var isDirty = false
    @State private var inlineIssue: String?
    @State private var saveState: SaveState = .idle
    /// Set while `loadConfig` swaps in the on-disk text, so the resulting
    /// `text` change isn't mistaken for a user edit (would flip isDirty).
    @State private var suppressNextChange = false
    /// Debounced `closerouter test` run for the current buffer.
    @State private var validationTask: Task<Void, Never>?

    private let server = ServerManager.shared

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            CodeTextView(text: $text)
                .onChange(of: text) {
                    guard !suppressNextChange else {
                        suppressNextChange = false
                        return
                    }
                    isDirty = true
                    saveState = .idle
                    scheduleValidation()
                }
            Divider()
            statusBar
        }
        .onAppear(perform: loadConfig)
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 1) {
                Text("closerouter.json")
                    .font(.headline)
                Text(ConfigStore.configURL.path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Validate") { validateNow() }
                .disabled(text.isEmpty)
            Button("Format") { formatNow() }
                .disabled(text.isEmpty)
            Button("Save") { saveNow() }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut("s", modifiers: .command)
                .disabled(text.isEmpty || !isDirty)
        }
        .padding(10)
    }

    private var statusBar: some View {
        HStack(spacing: 6) {
            if case .saving = saveState {
                ProgressView().controlSize(.small)
                Text("Saving…").foregroundStyle(.secondary)
            } else if case .saved(let msg) = saveState {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text(msg).foregroundStyle(.secondary)
            } else if case .error(let msg) = saveState {
                Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
                Text(msg).foregroundStyle(.red).lineLimit(1...4)
            } else if let inlineIssue {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(inlineIssue).foregroundStyle(.orange).lineLimit(1...4)
            } else {
                Text(isDirty ? "Unsaved changes" : "No unsaved changes")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(serverStateLabel)
                .foregroundStyle(.secondary)
                .font(.caption)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(minHeight: 28)
    }

    private var serverStateLabel: String {
        switch server.state {
        case .running(let version):
            let v = version.map { " · v\($0)" } ?? ""
            return "server running\(v) on port \(server.port)"
        case .stopped:
            return "server stopped"
        case .starting:
            return "server starting…"
        case .stopping:
            return "server stopping…"
        }
    }

    private func loadConfig() {
        try? ConfigStore.ensureConfigFile()
        suppressNextChange = true
        if let raw = try? String(contentsOf: ConfigStore.configURL, encoding: .utf8) {
            text = raw
        } else {
            text = ""
        }
        isDirty = false
        inlineIssue = nil
        saveState = .idle
    }

    /// Debounced validation: the `closerouter test` spawn is too heavy for
    /// every keystroke, so typing settles before it runs. Stale results (the
    /// buffer changed while testing) are dropped.
    private func scheduleValidation() {
        validationTask?.cancel()
        let snapshot = text
        validationTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            let outcome = await ConfigTester.test(configString: snapshot)
            guard !Task.isCancelled, snapshot == text else { return }
            inlineIssue = outcome.valid ? nil : outcome.joinedIssues
        }
    }

    private func validateNow() {
        validationTask?.cancel()
        let snapshot = text
        validationTask = Task {
            let outcome = await ConfigTester.test(configString: snapshot)
            guard snapshot == text else { return }
            if outcome.valid {
                inlineIssue = nil
                saveState = .saved("Config is valid")
            } else {
                inlineIssue = outcome.joinedIssues
            }
        }
    }

    private func formatNow() {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) else {
            saveState = .error("Cannot format: invalid JSON")
            return
        }
        if let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .withoutEscapingSlashes]),
           let formatted = String(data: pretty, encoding: .utf8) {
            text = formatted
        }
    }

    private func saveNow() {
        validationTask?.cancel()
        saveState = .saving
        let snapshot = text
        Task {
            // Validate through the same binary the server runs - if it isn't
            // accepted here, the server would reject the boot.
            let outcome = await ConfigTester.test(configString: snapshot)
            guard snapshot == text else {
                saveState = .idle // buffer changed while saving; let the user retry
                return
            }
            guard outcome.valid else {
                inlineIssue = outcome.joinedIssues
                saveState = .error(outcome.joinedIssues)
                return
            }
            inlineIssue = nil
            let oldPort = server.port
            let newPort = (try? ConfigStore.port(of: snapshot)) ?? oldPort

            do {
                if server.state.isRunning {
                    try await APIClient.putConfig(snapshot, port: server.port, key: server.key)
                }
                try ConfigStore.save(snapshot)
                if newPort != oldPort {
                    server.restart() // new port only takes effect after a restart
                } else {
                    server.refreshConfig() // keep the runtime key in sync with the saved config
                }
                if snapshot == text {
                    isDirty = false
                    saveState = .saved("Saved")
                } else {
                    isDirty = true
                    saveState = .idle
                }
            } catch {
                isDirty = true
                if snapshot == text {
                    saveState = .error(error.localizedDescription)
                }
            }
        }
    }
}
