import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @AppStorage("launchAtLogin") private var launchAtLogin = false
    @AppStorage("startServerOnLaunch") private var startServerOnLaunch = false
    @AppStorage("notificationsEnabled") private var notificationsEnabled = true
    @AppStorage("hideDockIcon") private var hideDockIcon = false
    @AppStorage("checkForUpdatesAutomatically") private var checkForUpdatesAutomatically = true

    @ObservedObject private var server = ServerManager.shared
    @ObservedObject private var updateChecker = UpdateChecker.shared
    @EnvironmentObject private var appState: AppState
    @State private var loginItemStatus = SMAppService.mainApp.status
    @State private var loginItemError: String?

    var body: some View {
        Form {
            Section("General") {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, on in
                        applyLoginItem(on)
                    }
                if let loginItemError {
                    Text(loginItemError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                Toggle("Start server on launch", isOn: $startServerOnLaunch)
                    .help("Automatically starts the proxy server when CloseRouter launches.")
                Toggle("Show notifications", isOn: $notificationsEnabled)
                    .help("Notifications for server start and unexpected stops.")
                Toggle("Hide Dock icon", isOn: $hideDockIcon)
                    .onChange(of: hideDockIcon) { _, hidden in
                        (NSApp.delegate as? AppDelegate)?.setDockIconHidden(hidden)
                    }
                    .help("Runs without a Dock icon; the app stays in the menu bar and the server keeps running.")
            }

            Section("Server") {
                LabeledContent("Status") {
                    Text(statusLabel).foregroundStyle(statusColor)
                }
                LabeledContent("Port", value: "\(server.port)")
                LabeledContent("Config file", value: ConfigStore.configURL.path)
                HStack {
                    Button("Open in editor") {
                        appState.section = .config
                    }
                    Button("Restart server") {
                        server.restart()
                    }
                    .disabled(!server.state.isRunning)
                }
            }

            Section("Updates") {
                LabeledContent("Current version", value: "v\(versionLabel)")
                Toggle("Check for updates automatically", isOn: $checkForUpdatesAutomatically)
                    .help("Checks GitHub releases when the app launches.")
                HStack {
                    Button("Check Now") {
                        Task { await UpdateChecker.shared.check() }
                    }
                    .disabled(UpdateChecker.shared.state.isChecking)
                    if case .available(let version, let url, _) = UpdateChecker.shared.state {
                        Link("Download \(version)", destination: URL(string: url)!)
                            .fontWeight(.medium)
                    }
                    if UpdateChecker.shared.state.isChecking {
                        ProgressView().controlSize(.small)
                    }
                }
                updateStatusText
            }

            Section("About") {
                LabeledContent("Version", value: versionLabel)
                LabeledContent("Endpoint", value: "http://localhost:\(server.port)/v1")
            }
        }
        .formStyle(.grouped)
        .padding()
    }

    private var statusLabel: String {
        switch server.state {
        case .running(let version):
            let v = version.map { " · v\($0)" } ?? ""
            return "Running\(v) on port \(server.port)"
        case .stopped:
            return "Stopped"
        case .starting:
            return "Starting…"
        case .stopping:
            return "Stopping…"
        }
    }

    private var statusColor: Color {
        switch server.state {
        case .running: .green
        case .stopped, .starting, .stopping: .secondary
        }
    }

    private var versionLabel: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    private var updateStatusText: some View {
        Group {
            switch updateChecker.state {
            case .idle:
                Text("Last checked: never")
            case .checking:
                Text("Checking GitHub releases…")
            case .upToDate:
                Label("You're up to date", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            case .available(let version, _, _):
                Label("\(version) is available", systemImage: "arrow.down.circle.fill")
                    .foregroundStyle(.orange)
            case .failed(let message):
                Label("Update check failed: \(message)", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.red)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private func applyLoginItem(_ on: Bool) {
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            loginItemError = nil
        } catch {
            loginItemError = on
                ? "Couldn't register login item: \(error.localizedDescription)"
                : "Couldn't unregister login item: \(error.localizedDescription)"
        }
        loginItemStatus = SMAppService.mainApp.status
    }
}
