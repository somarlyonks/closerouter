import SwiftUI

struct ConfigView: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "doc.badge.gearshape")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Config editor")
                .font(.headline)
            Text("Coming in a later milestone.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
