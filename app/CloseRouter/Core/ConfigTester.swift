import Foundation

/// Runs the bundled closerouter binary's `test` command, so the app validates
/// configs through the exact schema-driven rules the server enforces - one
/// validator, no Swift reimplementation of the JSON Schema subset. The command
/// prints schema issues to stderr and exits 1 on invalid configs; it is
/// silent and exits 0 when valid.
enum ConfigTester {
    struct Outcome {
        let valid: Bool
        /// One entry per schema issue, e.g. `"port" must be a number between 1 and 65535`.
        let issues: [String]

        var joinedIssues: String { issues.joined(separator: "\n") }
    }

    /// Tests a raw config JSON string (the editor's buffer).
    static func test(configString: String) async -> Outcome {
        await run(["test", "--stdin"], input: Data(configString.utf8))
    }

    private static func run(_ arguments: [String], input: Data) async -> Outcome {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: runBlocking(arguments, input: input))
            }
        }
    }

    private static func runBlocking(_ arguments: [String], input: Data) -> Outcome {
        guard let binary = Bundle.main.url(forResource: "closerouter", withExtension: nil) else {
            return Outcome(valid: false, issues: ["closerouter binary not found in the app bundle"])
        }
        // Each run gets its own stderr file because cancelling the calling Task
        // does not stop work already dispatched to the background queue.
        let stderrURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("closerouter-test-\(UUID().uuidString).stderr")
        defer { try? FileManager.default.removeItem(at: stderrURL) }
        do {
            try Data().write(to: stderrURL)
            let process = Process()
            process.executableURL = binary
            process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice
            let stderrHandle = try FileHandle(forWritingTo: stderrURL)
            defer { try? stderrHandle.close() }
            process.standardError = stderrHandle
            let inputPipe = Pipe()
            defer {
                try? inputPipe.fileHandleForWriting.close()
                try? inputPipe.fileHandleForReading.close()
            }
            process.standardInput = inputPipe
            try process.run()
            do {
                try inputPipe.fileHandleForWriting.write(contentsOf: input)
                try inputPipe.fileHandleForWriting.close()
            } catch {
                if process.isRunning {
                    process.terminate()
                    process.waitUntilExit()
                }
                throw error
            }
            process.waitUntilExit()
            if process.terminationStatus == 0 {
                return Outcome(valid: true, issues: [])
            }
            let stderrText = (try? String(contentsOf: stderrURL, encoding: .utf8)) ?? ""
            return Outcome(valid: false, issues: splitIssues(stderrText))
        } catch {
            return Outcome(valid: false, issues: ["failed to run closerouter test: \(error.localizedDescription)"])
        }
    }

    /// Splits the command's `; `-joined issue line into one entry per issue.
    /// Separators inside parentheses (oneOf branch reasons like
    /// "must be a string; must be an object") belong to a single issue.
    private static func splitIssues(_ text: String) -> [String] {
        var issues: [String] = []
        var current = ""
        var depth = 0
        for ch in text {
            if ch == "(" { depth += 1 }
            if ch == ")" { depth = max(0, depth - 1) }
            if depth == 0 && (ch == ";" || ch == "\n") {
                appendCurrent()
                continue
            }
            current.append(ch)
        }
        appendCurrent()
        return issues

        func appendCurrent() {
            let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { issues.append(trimmed) }
            current = ""
        }
    }
}
