import SwiftUI

struct SidebarView: View {
    @Binding var selection: AppSection?
    @ObservedObject private var server = ServerManager.shared

    private var visibleSections: [AppSection] {
        AppSection.allCases.filter { !$0.requiresDb || server.dbAvailable }
    }

    var body: some View {
        List(selection: $selection) {
            Section("CloseRouter") {
                ForEach(visibleSections) { section in
                    Label(section.title, systemImage: section.systemImage)
                        .tag(section)
                }
            }
        }
        .listStyle(.sidebar)
        // Fixed column: NSSplitView would otherwise steal/give width to the
        // sidebar whenever the detail view's minimum width changes (e.g. the
        // analytics filter bar during reloads).
        .navigationSplitViewColumnWidth(200)
    }
}
