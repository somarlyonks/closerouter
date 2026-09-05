import SwiftUI

struct SidebarView: View {
    @Binding var selection: AppSection?

    var body: some View {
        List(selection: $selection) {
            Section("CloseRouter") {
                ForEach(AppSection.allCases) { section in
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
