import Combine
import Foundation

struct LogEvent: Decodable {
    let id: String
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
}

struct LogHistory: Decodable {
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
}

struct LogGroup: Identifiable, Equatable {
    let requestId: String
    var id: String { requestId }
    /// Numeric usage-DB row id (from history); nil for live events.
    var dbId: Int?
    let time: Date
    let method: String
    let path: String
    var provider: String?
    var model: String?
    var status: Int?
    var durationMs: Int?
    var ttftMs: Int?
    var generationMs: Int?
    var inputTokens: Int?
    var outputTokens: Int?
    var cachedTokens: Int?
    var requestBody: String?
    var responseBody: String?

    init(event: LogEvent) {
        requestId = event.id
        dbId = nil
        time = Date(timeIntervalSince1970: event.time / 1000)
        method = event.method
        path = event.path
        provider = event.provider
        model = event.model
        status = event.status
        durationMs = event.durationMs
        ttftMs = event.ttftMs
        generationMs = event.generationMs
        inputTokens = event.inputTokens
        outputTokens = event.outputTokens
        cachedTokens = event.cachedTokens
        requestBody = event.requestBody
        responseBody = event.responseBody
    }

    init(history: LogHistory) {
        requestId = history.requestId
        dbId = history.id
        time = Date(timeIntervalSince1970: history.time / 1000)
        method = history.method
        path = history.path
        provider = history.provider
        model = history.model
        status = history.status
        durationMs = history.durationMs
        ttftMs = history.ttftMs
        generationMs = history.generationMs
        inputTokens = history.inputTokens
        outputTokens = history.outputTokens
        cachedTokens = history.cachedTokens
        requestBody = history.requestBody
        responseBody = history.responseBody
    }

    /// Fold a newer group for the same request into this one. The response phase
    /// is self-contained, so this overwrites the optional response-side fields;
    /// the fallbacks keep a filled row intact if an update ever omits a field.
    mutating func merge(_ other: LogGroup) {
        dbId = other.dbId ?? dbId
        provider = other.provider ?? provider
        model = other.model ?? model
        status = other.status ?? status
        durationMs = other.durationMs ?? durationMs
        ttftMs = other.ttftMs ?? ttftMs
        generationMs = other.generationMs ?? generationMs
        inputTokens = other.inputTokens ?? inputTokens
        outputTokens = other.outputTokens ?? outputTokens
        cachedTokens = other.cachedTokens ?? cachedTokens
        requestBody = other.requestBody ?? requestBody
        responseBody = other.responseBody ?? responseBody
    }
}

/// Consumes the /logs SSE stream and maintains a live, filterable list of log groups.
@MainActor
final class LogsViewModel: ObservableObject {
    private let server = ServerManager.shared

    @Published private(set) var groups: [LogGroup] = []
    @Published private(set) var isConnected = false
    @Published var isPaused = false
    @Published var filterText = ""

    private var groupsById: [String: Int] = [:]
    private var pendingBuffer: [LogGroup] = []
    private var loadingBodies: Set<Int> = []
    private var streamTask: Task<Void, Never>?
    private var stateCancellable: AnyCancellable?
    private let maxRows = 500

    var displayedGroups: [LogGroup] {
        guard !filterText.isEmpty else { return groups }
        let f = filterText.lowercased()
        return groups.filter { group in
            group.method.lowercased().contains(f)
                || group.path.lowercased().contains(f)
                || (group.status.map { String($0).contains(f) } ?? false)
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
            for group in pendingBuffer { apply(group) }
            pendingBuffer.removeAll()
        }
    }

    func clear() {
        groups.removeAll()
        groupsById.removeAll()
        loadingBodies.removeAll()
    }

    /// History entries never carry bodies (the server omits them from /logs JSON),
    /// so fetch a single row's bodies on demand via /logs/<id> when the row is shown.
    func loadBodies(for rowID: LogGroup.ID?) {
        guard let rowID, let idx = groupsById[rowID], let dbId = groups[idx].dbId else { return }
        guard !loadingBodies.contains(dbId) else { return }
        loadingBodies.insert(dbId)
        let port = server.port
        let key = authKey()
        Task { [weak self] in
            defer { self?.loadingBodies.remove(dbId) }
            guard let detail = try? await APIClient.getLogDetail(port: port, key: key, id: dbId) else { return }
            guard let self, let idx = self.groupsById[rowID] else { return }
            self.groups[idx].requestBody = detail.requestBody ?? self.groups[idx].requestBody
            self.groups[idx].responseBody = detail.responseBody ?? self.groups[idx].responseBody
        }
    }

    func isLoadingBodies(for rowID: LogGroup.ID?) -> Bool {
        guard let rowID, let idx = groupsById[rowID], let dbId = groups[idx].dbId else { return false }
        return loadingBodies.contains(dbId)
    }

    // MARK: Connection

    private func loadHistoryAndConnect() {
        Task { [weak self] in
            guard let self else { return }
            if let entries = try? await APIClient.getLogEntries(port: self.server.port, key: self.authKey()) {
                for group in entries { self.apply(group) }
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
                if eventName == "log", let group = parseLogGroup(dataLines.joined(separator: "\n")) {
                    handle(group)
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

    private func handle(_ group: LogGroup) {
        if isPaused {
            pendingBuffer.append(group)
            if pendingBuffer.count > 200 { pendingBuffer.removeFirst() }
            return
        }
        apply(group)
    }

    private func apply(_ group: LogGroup) {
        if let idx = groupsById[group.requestId] {
            groups[idx].merge(group)
            objectWillChange.send()
        } else {
            groups.append(group)
            groupsById[group.requestId] = groups.count - 1
            if groups.count > maxRows {
                groups.removeFirst(groups.count - maxRows)
                rebuildIndex()
            }
            objectWillChange.send()
        }
    }

    private func rebuildIndex() {
        groupsById.removeAll()
        for (i, group) in groups.enumerated() {
            groupsById[group.requestId] = i
        }
    }

    private func parseLogGroup(_ json: String) -> LogGroup? {
        guard let data = json.data(using: .utf8),
              let event = try? JSONDecoder().decode(LogEvent.self, from: data) else { return nil }
        return LogGroup(event: event)
    }

    private func authKey() -> String {
        (try? ConfigStore.read().key) ?? "sk-cr-kee9itsecr1t"
    }
}
