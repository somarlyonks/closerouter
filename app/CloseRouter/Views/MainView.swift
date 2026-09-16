import SwiftUI

enum AppSection: String, CaseIterable, Identifiable {
    case overview
    case config
    case logs
    case analytics
    case settings

    var id: Self { self }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .config: "Config"
        case .logs: "Logs"
        case .analytics: "Analytics"
        case .settings: "Settings"
        }
    }

    var systemImage: String {
        switch self {
        case .overview: "text.and.command.macwindow"
        case .config: "doc.badge.gearshape"
        case .logs: "terminal"
        case .analytics: "chart.bar.xaxis"
        case .settings: "gearshape"
        }
    }

    /// Sections backed by the usage db - only offered while the server
    /// reports a working sqlite (db configured and loadable).
    var requiresDb: Bool {
        switch self {
            case .logs, .analytics: return true
            case .overview, .config, .settings: return false
        }
    }
}

/// Shared navigation state so any view (e.g. Settings) can switch sections.
final class AppState: ObservableObject {
    @Published var section: AppSection? = .overview
}

struct MainView: View {
    @StateObject private var appState = AppState()
    @ObservedObject private var server = ServerManager.shared

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $appState.section)
        } detail: {
            switch appState.section {
                case .overview: OverviewView()
                case .config: ConfigEditorView()
                case .logs: LogsView()
                case .analytics: AnalyticsView()
                case .settings: SettingsView()
                case .none: EmptyView()
            }
        }
        .frame(minWidth: 720, minHeight: 420)
        .environmentObject(appState)
        .onChange(of: server.dbAvailable) { _, available in
            if !available, let section = appState.section, section.requiresDb {
                appState.section = .overview
            }
        }
    }
}
