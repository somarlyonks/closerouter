import ServiceManagement
import SwiftUI

struct SettingsView: View {
    @AppStorage("launchAtLogin") private var launchAtLogin = false
    @AppStorage("startServerOnLaunch") private var startServerOnLaunch = false
    @AppStorage("notificationsEnabled") private var notificationsEnabled = true

    @ObservedObject private var server = ServerManager.shared
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
