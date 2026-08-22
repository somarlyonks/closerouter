import AppKit

@MainActor
final class StatusBarController: NSObject {
    static let shared = StatusBarController()

    private var statusItem: NSStatusItem?

    func setup() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "network", accessibilityDescription: "CloseRouter")
            button.image?.isTemplate = true
        }

        let menu = NSMenu()
        let title = NSMenuItem(title: "CloseRouter", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(.separator())

        let open = NSMenuItem(title: "Open CloseRouter", action: #selector(openMainWindow), keyEquivalent: "")
        open.target = self
        menu.addItem(open)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit CloseRouter", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        item.menu = menu
        statusItem = item
    }

    @objc private func openMainWindow() {
        (NSApplication.shared.delegate as? AppDelegate)?.openMainWindow()
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }
}
