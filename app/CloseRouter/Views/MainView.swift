import SwiftUI

enum AppSection: String, CaseIterable, Identifiable {
    case config
    case logs
    case settings

    var id: Self { self }

    var title: String {
        switch self {
        case .config: "Config"
        case .logs: "Logs"
        case .settings: "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .config: "doc.badge.gearshape"
        case .logs: "terminal"
        case .settings: "gearshape"
        }
    }
}

/// Shared navigation state so any view (e.g. Settings) can switch sections.
final class AppState: ObservableObject {
    @Published var section: AppSection? = .config
}

struct MainView: View {
    @StateObject private var appState = AppState()

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $appState.section)
        } detail: {
            switch appState.section {
            case .config: ConfigEditorView()
            case .logs: LogsView()
            case .settings: SettingsView()
            case .none: EmptyView()
            }
        }
        .frame(minWidth: 720, minHeight: 420)
        .environmentObject(appState)
    }
}
