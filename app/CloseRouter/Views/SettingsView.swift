import SwiftUI

struct SettingsView: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "gearshape")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Settings")
                .font(.headline)
            Text("Coming in a later milestone.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
