import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    // @NSApplicationDelegateAdaptor wraps us in SwiftUI.AppDelegate, so NSApp.delegate
    // casts to AppDelegate fail — reach the real one through here.
    static var shared: AppDelegate!

    func applicationDidFinishLaunching(_ notification: Notification) {
        Self.shared = self
        try? ConfigStore.ensureConfigFile()
        AppNotifications.requestAuthorizationIfNeeded()
        StatusBarController.shared.setup()

        if Self.launchedAsLoginItem() {
            NSApp.setActivationPolicy(.accessory)
        } else if Preferences.hideDockIcon {
            NSApp.setActivationPolicy(.accessory)
        }

        if !Self.launchedAsLoginItem() {
            MainWindowController.shared.open()
        }
        if Preferences.startServerOnLaunch {
            ServerManager.shared.start()
        }
        if Preferences.checkForUpdatesAutomatically {
            UpdateChecker.shared.checkInBackground()
        }
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

    /// Hide/show the Dock icon at runtime; the status-bar item and the server keep running either way.
    func setDockIconHidden(_ hidden: Bool) {
        Preferences.hideDockIcon = hidden
        NSApp.setActivationPolicy(hidden ? .accessory : .regular)
        if !hidden {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func openMainWindow() {
        MainWindowController.shared.open()
    }

    private static func launchedAsLoginItem() -> Bool {
        let event = NSAppleEventManager.shared().currentAppleEvent
        return event?.eventID == kAEOpenApplication &&
            event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }
}
