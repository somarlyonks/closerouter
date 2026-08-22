import SwiftUI

@main
struct CloseRouterApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("CloseRouter", id: "main") {
            MainView()
        }
        .defaultSize(width: 900, height: 620)
    }
}
