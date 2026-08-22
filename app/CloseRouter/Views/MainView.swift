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

struct MainView: View {
    @State private var selection: AppSection? = .config

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $selection)
        } detail: {
            switch selection {
            case .config: ConfigEditorView()
            case .logs: LogsView()
            case .settings: SettingsView()
            case .none: EmptyView()
            }
        }
        .frame(minWidth: 720, minHeight: 420)
    }
}
