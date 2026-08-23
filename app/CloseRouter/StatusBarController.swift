import AppKit
import Combine

@MainActor
final class StatusBarController: NSObject {
    static let shared = StatusBarController()

    private var statusItem: NSStatusItem?
    private var cancellables = Set<AnyCancellable>()
    private var statusMenuItem: NSMenuItem?
    private var toggleItem: NSMenuItem?

    func setup() {
        guard statusItem == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            button.image = Self.makeMenuBarImage() ?? NSImage(systemSymbolName: "network", accessibilityDescription: "CloseRouter")
            button.image?.isTemplate = true
        }
        item.menu = buildMenu()
        statusItem = item
        updateMenu(for: ServerManager.shared.state)
        observeServer()
    }

    private static func makeMenuBarImage() -> NSImage? {
        guard let url = Bundle.main.url(forResource: "logo", withExtension: "svg"),
              let image = NSImage(contentsOf: url) else { return nil }
        let height: CGFloat = 16
        image.size = NSSize(width: round(height * image.size.width / image.size.height), height: height)
        image.accessibilityDescription = "CloseRouter"
        return image
    }

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        let title = NSMenuItem(title: "CloseRouter", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(.separator())

        statusMenuItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        statusMenuItem?.isEnabled = false
        menu.addItem(statusMenuItem!)

        toggleItem = NSMenuItem(title: "", action: #selector(toggleServer), keyEquivalent: "")
        toggleItem?.target = self
        menu.addItem(toggleItem!)

        menu.addItem(.separator())

        let open = NSMenuItem(title: "Open CloseRouter", action: #selector(openMainWindow), keyEquivalent: "")
        open.target = self
        menu.addItem(open)

        menu.addItem(.separator())

        let quit = NSMenuItem(title: "Quit CloseRouter", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        return menu
    }

    private func observeServer() {
        ServerManager.shared.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                self?.updateMenu(for: state)
            }
            .store(in: &cancellables)
    }

    private func updateMenu(for state: ServerManager.State) {
        statusMenuItem?.title = Self.statusTitle(for: state)
        toggleItem?.title = state.isRunning ? "Stop Server" : "Start Server"
        toggleItem?.isEnabled = !state.isTransitioning
    }

    private static func statusTitle(for state: ServerManager.State) -> String {
        switch state {
        case .stopped:
            return "Stopped"
        case .starting:
            return "Starting…"
        case .running(let version):
            let port = ServerManager.shared.port
            if let version {
                return "Running · v\(version) · port \(port)"
            }
            return "Running · port \(port)"
        case .stopping:
            return "Stopping…"
        }
    }

    @objc private func toggleServer() {
        ServerManager.shared.toggle()
    }

    @objc private func openMainWindow() {
        AppDelegate.shared?.openMainWindow()
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }
}
