import AppKit
import Combine
import Foundation

/// Spawns, monitors, and restarts the closerouter server as a managed child process.
@MainActor
final class ServerManager: ObservableObject {
    enum State: Equatable {
        case stopped
        case starting
        case running(version: String?)
        case stopping

        var isRunning: Bool {
            if case .running = self { return true }
            return false
        }

        var isTransitioning: Bool {
            switch self {
            case .starting, .stopping: return true
            case .stopped, .running: return false
            }
        }
    }

    static let shared = ServerManager()

    @Published private(set) var state: State = .stopped
    @Published private(set) var port: Int = 6712

    private var process: Process?
    private var healthTask: Task<Void, Never>?
    private var stopRequested = false
    private var restartBackoff: TimeInterval = 1.0

    private var binaryURL: URL? {
        Bundle.main.url(forResource: "closerouter", withExtension: nil)
    }

    private init() {
        port = (try? ConfigStore.read())?.port ?? 6712
    }

    func toggle() {
        switch state {
        case .stopped: start()
        case .running: stop()
        case .starting, .stopping: break
        }
    }

    func start() {
        guard !state.isTransitioning, !state.isRunning else { return }
        guard let binaryURL else {
            NSLog("closerouter binary not found in bundle")
            return
        }
        do {
            try ConfigStore.ensureConfigFile()
            port = try ConfigStore.read().port
        } catch {
            NSLog("failed to prepare config: \(error.localizedDescription)")
            return
        }

        let process = Process()
        process.executableURL = binaryURL
        process.arguments = ["server", "-c", ConfigStore.configURL.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                self?.processDidExit(proc)
            }
        }
        do {
            try process.run()
        } catch {
            NSLog("failed to start closerouter: \(error.localizedDescription)")
            return
        }

        self.process = process
        stopRequested = false
        restartBackoff = 1.0
        state = .starting
        startHealthMonitoring()
    }

    func stop() {
        guard let process, process.isRunning else {
            stopHealthMonitoring()
            self.process = nil
            state = .stopped
            return
        }
        stopRequested = true
        state = .stopping
        process.terminate()
        // Escalate to SIGKILL if it doesn't exit on its own.
        Task { [process] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
        }
    }

    /// Synchronous-ish shutdown for app termination (blocks briefly on the main thread).
    func terminateNow() {
        guard let process, process.isRunning else { return }
        stopHealthMonitoring()
        stopRequested = true
        process.terminate()
        for _ in 0..<20 {
            if !process.isRunning { break }
            usleep(100_000) // 0.1s
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
    }

    private func processDidExit(_ proc: Process) {
        guard proc === process else { return }
        process = nil
        stopHealthMonitoring()
        if stopRequested {
            stopRequested = false
            state = .stopped
        } else {
            // Unexpected exit — restart with backoff.
            let delay = min(restartBackoff, 30)
            restartBackoff *= 2
            state = .stopped
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard let self, self.process == nil, !self.stopRequested else { return }
                self.start()
            }
        }
    }

    private func startHealthMonitoring() {
        stopHealthMonitoring()
        healthTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let version = await self.queryStatus()
                if Task.isCancelled { return }
                if let version, let process = self.process, process.isRunning {
                    self.restartBackoff = 1.0
                    if !self.state.isRunning {
                        self.state = .running(version: version)
                    }
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    private func stopHealthMonitoring() {
        healthTask?.cancel()
        healthTask = nil
    }

    /// GET /status; returns the closerouter version string when healthy.
    private func queryStatus() async -> String? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/status") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return obj["version"] as? String
    }
}
