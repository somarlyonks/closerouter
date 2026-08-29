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
    @Published private(set) var startedAt: Date?

    private var process: Process?
    private var healthTask: Task<Void, Never>?
    private var stopRequested = false
    private var restartBackoff: TimeInterval = 1.0
    /// Byte offset in the stderr log where the current child's output begins, so a
    /// port-conflict from an earlier start can't be misread as the current child's.
    private var stderrStartOffset: UInt64 = 0

    private var stderrPath: String {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("closerouter-stderr.log").path
    }

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

    /// Stops the server and starts it again once it has fully stopped.
    func restart() {
        guard state.isRunning else { return }
        stop()
        Task { [weak self] in
            guard let self else { return }
            while self.state != .stopped {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            self.start()
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
        // Capture stderr to a log file so we can diagnose why the child exited
        // (e.g. the port already being in use) instead of restart-looping blind.
        // The log is append-only and retained across runs — past failures stay
        // readable for later diagnosis. Record where this run's output begins so
        // only the current child's stderr is examined when the child exits.
        if !FileManager.default.fileExists(atPath: stderrPath) {
            FileManager.default.createFile(atPath: stderrPath, contents: nil)
        }
        if let handle = FileHandle(forWritingAtPath: stderrPath) {
            handle.seekToEndOfFile()
            let marker = "\n----- \(Date()) server start -----\n"
            if let data = marker.data(using: .utf8) { handle.write(data) }
            stderrStartOffset = handle.offsetInFile
            process.standardError = handle
        } else {
            stderrStartOffset = UInt64.max
            process.standardError = FileHandle.nullDevice
        }
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
        startedAt = Date()
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
        stopHealthMonitoring()
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
        startedAt = nil
        stopHealthMonitoring()
        if stopRequested {
            stopRequested = false
            state = .stopped
        } else {
            // Port conflict is a user action (another process holds the port), not a
            // crash — surface it and stay stopped instead of restart-looping.
            if failedDueToPortConflict() {
                AppNotifications.post(
                    title: "Couldn't start CloseRouter server",
                    body: "Port \(port) is already in use. Stop the other process or change the port in Config."
                )
                state = .stopped
                return
            }
            // Unexpected exit — restart with backoff.
            AppNotifications.post(
                title: "CloseRouter server stopped",
                body: "It stopped unexpectedly and will restart."
            )
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

    /// True when the current child failed to bind because the port is already taken.
    /// Node's server.listen emits an unhandled EADDRINUSE error to stderr before exiting.
    /// Only this run's segment of the retained log is inspected.
    private func failedDueToPortConflict() -> Bool {
        guard let handle = FileHandle(forReadingAtPath: stderrPath) else { return false }
        defer { try? handle.close() }
        let end = handle.seekToEndOfFile()
        guard end > stderrStartOffset else { return false }
        handle.seek(toFileOffset: stderrStartOffset)
        let length = Int(end - stderrStartOffset)
        guard let data = try? handle.read(upToCount: length),
              let text = String(data: data, encoding: .utf8) else { return false }
        return text.contains("EADDRINUSE") || text.contains("address already in use")
    }

    private func startHealthMonitoring() {
        stopHealthMonitoring()
        healthTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let version = await self.queryStatus()
                if Task.isCancelled || self.stopRequested { return }
                if let version, let process = self.process, process.isRunning {
                    self.restartBackoff = 1.0
                    if !self.state.isRunning {
                        self.state = .running(version: version)
                        AppNotifications.post(
                            title: "CloseRouter server started",
                            body: "Running on port \(self.port)"
                        )
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
