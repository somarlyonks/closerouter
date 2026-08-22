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
                    inlineIssue = ConfigValidator.validate(text)
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
                Text(msg).foregroundStyle(.red).lineLimit(2)
            } else if let inlineIssue {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(inlineIssue).foregroundStyle(.orange).lineLimit(2)
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

    private func validateNow() {
        inlineIssue = ConfigValidator.validate(text)
        if inlineIssue == nil {
            saveState = .saved("Config is valid")
        }
    }

    private func formatNow() {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) else {
            saveState = .error("Cannot format: invalid JSON")
            return
        }
        if let pretty = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
           let formatted = String(data: pretty, encoding: .utf8) {
            text = formatted
        }
    }

    private func saveNow() {
        if let issue = ConfigValidator.validate(text) {
            saveState = .error(issue)
            return
        }
        let oldPort = server.port
        let newPort = (try? ConfigStore.port(of: text)) ?? oldPort

        saveState = .saving
        if server.state.isRunning {
            Task {
                do {
                    let key = (try? ConfigStore.read().key) ?? "sk-cr-kee9itsecr1t"
                    try await APIClient.putConfig(text, port: server.port, key: key)
                    try ConfigStore.save(text)
                    if newPort != oldPort {
                        server.restart() // new port only takes effect after a restart
                    }
                    saveState = .saved("Saved")
                } catch {
                    saveState = .error(error.localizedDescription)
                }
            }
        } else {
            do {
                try ConfigStore.save(text)
                saveState = .saved("Saved")
            } catch {
                saveState = .error(error.localizedDescription)
            }
        }
        isDirty = false
    }
}
