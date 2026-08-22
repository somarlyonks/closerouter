import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        try? ConfigStore.ensureConfigFile()
        AppNotifications.requestAuthorizationIfNeeded()
        StatusBarController.shared.setup()
        applyLaunchBehavior()
    }

    func applicationWillTerminate(_ notification: Notification) {
        ServerManager.shared.terminateNow()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // Menu bar app: keep running with the status item after the window closes.
        false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openMainWindow()
        return true
    }

    func openMainWindow() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Menu-bar-only behavior when launched as a login item, and optional server auto-start.
    private func applyLaunchBehavior() {
        if Self.launchedAsLoginItem() {
            NSApp.setActivationPolicy(.accessory)
            Task { @MainActor in
                NSApp.windows.first?.close()
            }
        }
        if Preferences.startServerOnLaunch {
            ServerManager.shared.start()
        }
    }

    private static func launchedAsLoginItem() -> Bool {
        let event = NSAppleEventManager.shared().currentAppleEvent
        return event?.eventID == kAEOpenApplication &&
            event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }
}
