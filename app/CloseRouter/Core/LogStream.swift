import Combine
import Foundation

/// One event from the server's /logs endpoint (either the request or response phase).
struct LogEntry: Codable {
    var id: Int? = nil
    let requestId: String
    let phase: String
    let time: Double
    let method: String
    let path: String
    let status: Int?
    let durationMs: Int?
    let ttftMs: Int?
    let generationMs: Int?
    let inputTokens: Int?
    let outputTokens: Int?
    let cachedTokens: Int?
    let requestBody: String?
    let responseBody: String?

    enum CodingKeys: String, CodingKey {
        case requestId = "id"
        case phase
        case time
        case method
        case path
        case status
        case durationMs
        case ttftMs
        case generationMs
        case inputTokens
        case outputTokens
        case cachedTokens
        case requestBody
        case responseBody
    }
}

/// An entry from the usage DB (GET /logs with Accept: application/json).
/// Different shape: numeric row `id`, the request UUID in `requestId`, and no `phase`.
struct LogHistoryEntry: Codable {
    let id: Int
    let requestId: String
    let time: Double
    let method: String
    let path: String
    let provider: String?
    let model: String?
    let status: Int?
    let durationMs: Int?
    let ttftMs: Int?
    let generationMs: Int?
    let inputTokens: Int?
    let outputTokens: Int?
    let cachedTokens: Int?
    let requestBody: String?
    let responseBody: String?

    var asLogEntry: LogEntry {
        LogEntry(
            id: id,
            requestId: requestId,
            phase: "response",
            time: time,
            method: method,
            path: path,
            status: status,
            durationMs: durationMs,
            ttftMs: ttftMs,
            generationMs: generationMs,
            inputTokens: inputTokens,
            outputTokens: outputTokens,
            cachedTokens: cachedTokens,
            requestBody: requestBody,
            responseBody: responseBody
        )
    }
}

/// A single request row; the response phase merges into the row started by the request phase.
struct LogRow: Identifiable {
    let requestId: String
    var id: String { requestId }
    let dbId: Int?
    let time: Date
    let method: String
    let path: String
    var status: Int?
    var durationMs: Int?
    var ttftMs: Int?
    var inputTokens: Int?
    var outputTokens: Int?
    var cachedTokens: Int?
    var requestBody: String?
    var responseBody: String?

    init(entry: LogEntry) {
        requestId = entry.requestId
        dbId = entry.id
        time = Date(timeIntervalSince1970: entry.time / 1000)
        method = entry.method
        path = entry.path
        status = entry.status
        durationMs = entry.durationMs
        ttftMs = entry.ttftMs
        inputTokens = entry.inputTokens
        outputTokens = entry.outputTokens
        cachedTokens = entry.cachedTokens
        requestBody = entry.requestBody
        responseBody = entry.responseBody
    }

    mutating func merge(_ entry: LogEntry) {
        status = entry.status ?? status
        durationMs = entry.durationMs ?? durationMs
        ttftMs = entry.ttftMs ?? ttftMs
        inputTokens = entry.inputTokens ?? inputTokens
        outputTokens = entry.outputTokens ?? outputTokens
        cachedTokens = entry.cachedTokens ?? cachedTokens
        requestBody = entry.requestBody ?? requestBody
        responseBody = entry.responseBody ?? responseBody
    }
}

/// Consumes the /logs SSE stream and maintains a live, filterable list of request rows.
@MainActor
final class LogsViewModel: ObservableObject {
    private let server = ServerManager.shared

    @Published private(set) var rows: [LogRow] = []
    @Published private(set) var isConnected = false
    @Published var isPaused = false
    @Published var filterText = ""

    private var rowsById: [String: Int] = [:]
    private var pendingBuffer: [LogEntry] = []
    private var loadingBodies: Set<Int> = []
    private var streamTask: Task<Void, Never>?
    private var stateCancellable: AnyCancellable?
    private let maxRows = 500

    var displayedRows: [LogRow] {
        guard !filterText.isEmpty else { return rows }
        let f = filterText.lowercased()
        return rows.filter { row in
            row.method.lowercased().contains(f)
                || row.path.lowercased().contains(f)
                || (row.status.map { String($0).contains(f) } ?? false)
        }
    }

    // MARK: Lifecycle

    func start() {
        guard stateCancellable == nil else { return }
        stateCancellable = server.$state.sink { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                if state.isRunning {
                    if self.streamTask == nil {
                        self.loadHistoryAndConnect()
                    }
                } else {
                    self.disconnect()
                }
            }
        }
        if server.state.isRunning {
            loadHistoryAndConnect()
        }
    }

    func stop() {
        disconnect()
        stateCancellable?.cancel()
        stateCancellable = nil
    }

    // MARK: Controls

    func togglePause() {
        isPaused.toggle()
        if !isPaused {
            for entry in pendingBuffer { apply(entry) }
            pendingBuffer.removeAll()
        }
    }

    func clear() {
        rows.removeAll()
        rowsById.removeAll()
        loadingBodies.removeAll()
    }

    /// History entries never carry bodies (the server omits them from /logs JSON),
    /// so fetch a single row's bodies on demand via /logs/<id> when the row is shown.
    func loadBodies(for rowID: LogRow.ID?) {
        guard let rowID, let idx = rowsById[rowID], let dbId = rows[idx].dbId else { return }
        guard !loadingBodies.contains(dbId) else { return }
        loadingBodies.insert(dbId)
        let port = server.port
        let key = authKey()
        Task { [weak self] in
            defer { self?.loadingBodies.remove(dbId) }
            guard let detail = try? await APIClient.getLogDetail(port: port, key: key, id: dbId) else { return }
            guard let self, let idx = self.rowsById[rowID] else { return }
            self.rows[idx].requestBody = detail.requestBody ?? self.rows[idx].requestBody
            self.rows[idx].responseBody = detail.responseBody ?? self.rows[idx].responseBody
        }
    }

    func isLoadingBodies(for rowID: LogRow.ID?) -> Bool {
        guard let rowID, let idx = rowsById[rowID], let dbId = rows[idx].dbId else { return false }
        return loadingBodies.contains(dbId)
    }

    // MARK: Connection

    private func loadHistoryAndConnect() {
        Task { [weak self] in
            guard let self else { return }
            if let entries = try? await APIClient.getLogEntries(port: self.server.port, key: self.authKey()) {
                for entry in entries { self.apply(entry) }
            }
            self.connect()
        }
    }

    private func connect() {
        guard streamTask == nil, server.state.isRunning else { return }
        let port = server.port
        let key = authKey()
        streamTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.server.state.isRunning else { break }
                do {
                    try await self.runStreamOnce(port: port, key: key)
                } catch {
                    // Connection dropped — fall through and retry.
                }
                if Task.isCancelled { break }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
            self?.streamTask = nil
        }
    }

    private func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        isConnected = false
    }

    private func runStreamOnce(port: Int, key: String) async throws {
        guard let url = URL(string: "http://127.0.0.1:\(port)/logs") else { return }
        var request = URLRequest(url: url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("cr-key=\(key)", forHTTPHeaderField: "Cookie")
        request.timeoutInterval = 30

        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        isConnected = true
        defer { isConnected = false }

        var eventName = ""
        var dataLines: [String] = []
        for try await line in bytes.lines {
            if line.isEmpty {
                if eventName == "log", let entry = parseLogEntry(dataLines.joined(separator: "\n")) {
                    handle(entry)
                }
                eventName = ""
                dataLines = []
            } else if line.hasPrefix("event:") {
                eventName = line.dropFirst("event:".count).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces))
            }
        }
    }

    // MARK: Entry handling

    private func handle(_ entry: LogEntry) {
        if isPaused {
            pendingBuffer.append(entry)
            if pendingBuffer.count > 200 { pendingBuffer.removeFirst() }
            return
        }
        apply(entry)
    }

    private func apply(_ entry: LogEntry) {
        if let idx = rowsById[entry.requestId] {
            rows[idx].merge(entry)
            objectWillChange.send()
        } else {
            rows.append(LogRow(entry: entry))
            rowsById[entry.requestId] = rows.count - 1
            if rows.count > maxRows {
                rows.removeFirst(rows.count - maxRows)
                rebuildIndex()
            }
            objectWillChange.send()
        }
    }

    private func rebuildIndex() {
        rowsById.removeAll()
        for (i, row) in rows.enumerated() {
            rowsById[row.requestId] = i
        }
    }

    private func parseLogEntry(_ json: String) -> LogEntry? {
        guard let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(LogEntry.self, from: data)
    }

    private func authKey() -> String {
        (try? ConfigStore.read().key) ?? "sk-cr-kee9itsecr1t"
    }
}
