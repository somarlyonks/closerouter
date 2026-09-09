import Combine
import Foundation

/// One row of the batched GET /logs history (the usage DB). Bodies are never
/// included - fetch them per row via /logs/<id>.
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
    /// Numeric usage-DB row id. The stable identity of a row, matching the web
    /// UI's dedup key; also used to fetch bodies on demand via /logs/<id>.
    let id: Int
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

    init(history: LogHistory) {
        id = history.id
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

    /// Adopt a refreshed history row for the same id. Rows are immutable
    /// once recorded, so this is effectively a no-op; it exists to keep the
    /// dedup merge stable if a row ever changes.
    mutating func merge(_ other: LogGroup) {
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

/// Maintains the logs table by on-demand GET /logs history fetches (manual
/// Refresh), deduplicating rows by usage-DB row id.
@MainActor
final class LogsViewModel: ObservableObject {
    private let server = ServerManager.shared

    @Published private(set) var groups: [LogGroup] = []
    @Published private(set) var lastUpdated: Date?
    @Published var filterText = ""

    private var groupsById: [Int: Int] = [:]
    /// dbIds currently fetching bodies for. @Published so the detail pane re-renders
    /// when a fetch starts (spinner) and when it ends (falls through to "No body").
    @Published private(set) var loadingBodies: Set<Int> = []
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
                if state.isRunning { self.refresh() }
            }
        }
        if server.state.isRunning {
            refresh()
        }
    }

    func stop() {
        stateCancellable?.cancel()
        stateCancellable = nil
    }

    // MARK: Controls

    func refresh() {
        guard server.state.isRunning else { return }
        Task { [weak self] in
            await self?.load()
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
        guard let rowID, groupsById[rowID] != nil else { return }
        guard !loadingBodies.contains(rowID) else { return }
        loadingBodies.insert(rowID)
        let port = server.port
        let key = server.key
        Task { [weak self] in
            defer { self?.loadingBodies.remove(rowID) }
            guard let detail = try? await APIClient.getLogDetail(port: port, key: key, id: rowID) else { return }
            guard let self, let idx = self.groupsById[rowID] else { return }
            self.groups[idx].requestBody = detail.requestBody ?? self.groups[idx].requestBody
            self.groups[idx].responseBody = detail.responseBody ?? self.groups[idx].responseBody
        }
    }

    func isLoadingBodies(for rowID: LogGroup.ID?) -> Bool {
        guard let rowID, groupsById[rowID] != nil else { return false }
        return loadingBodies.contains(rowID)
    }

    // MARK: Loading

    private func load() async {
        guard server.state.isRunning else { return }
        guard let entries = try? await APIClient.getLogEntries(port: server.port, key: server.key) else { return }
        for group in entries { apply(group) }
        lastUpdated = Date()
    }

    // MARK: Entry handling

    private func apply(_ group: LogGroup) {
        if let idx = groupsById[group.id] {
            groups[idx].merge(group)
            objectWillChange.send()
        } else {
            groups.insert(group, at: 0)
            if groups.count > maxRows {
                groups.removeLast(groups.count - maxRows)
            }
            rebuildIndex()
            objectWillChange.send()
        }
    }

    private func rebuildIndex() {
        groupsById.removeAll()
        for (i, group) in groups.enumerated() {
            groupsById[group.id] = i
        }
    }
}
