import SwiftUI

// The main window is owned by AppKit rather than a WindowGroup: closing a
// WindowGroup window destroys it, which made reopening impossible (openWindow
// actions go stale, and SwiftUI clears any NSWindowDelegate we install).
// Keeping one NSWindow alive forever — "close" just orders it out — sidesteps
// all of that while the status-bar item and server stay running.
@MainActor
final class MainWindowController: NSObject, NSWindowDelegate {
    static let shared = MainWindowController()

    private var window: NSWindow?

    func open() {
        if !Preferences.hideDockIcon {
            NSApp.setActivationPolicy(.regular)
        }
        NSApp.activate(ignoringOtherApps: true)
        let window = ensureWindow()
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
    }

    private func ensureWindow() -> NSWindow {
        if let window { return window }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "CloseRouter"
        window.contentMinSize = NSSize(width: 720, height: 420)
        window.contentView = NSHostingView(rootView: MainView())
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("MainWindow")
        window.delegate = self
        window.center()
        self.window = window
        return window
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}

@main
struct CloseRouterApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // No WindowGroup: the main window is managed by MainWindowController.
        Settings { EmptyView() }
    }
}
