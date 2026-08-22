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
        .navigationSplitViewColumnWidth(min: 180, ideal: 200)
    }
}
