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
}

/// One page of log history plus the total number of matching rows.
struct LogPage {
    let groups: [LogGroup]
    let total: Int
}

/// Loads one page at a time from GET /logs, newest page first. Filtering and
/// paging happen server-side so search spans the whole history rather than
/// only the rows currently on screen.
@MainActor
final class LogsViewModel: ObservableObject {
    private let server = ServerManager.shared

    @Published private(set) var groups: [LogGroup] = []
    @Published private(set) var total = 0
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var isLoading = false
    @Published var filterText = ""
    /// Zero-based page index; page 0 holds the newest rows.
    @Published private(set) var page = 0

    private var groupsById: [Int: Int] = [:]
    /// dbIds currently fetching bodies for. @Published so the detail pane re-renders
    /// when a fetch starts (spinner) and when it ends (falls through to "No body").
    @Published private(set) var loadingBodies: Set<Int> = []
    private var stateCancellable: AnyCancellable?
    private var filterCancellable: AnyCancellable?
    /// In-flight page fetch; a newer refresh cancels it so a stale response can
    /// never overwrite the page the user is looking at.
    private var loadTask: Task<Void, Never>?
    /// Monotonic id compared after each await - cancellation is cooperative, so
    /// a fetch that already resolved still checks this before applying its rows.
    private var loadGeneration = 0
    private let pageSize = 100

    var displayedGroups: [LogGroup] { groups }

    var pageCount: Int { max(1, Int(ceil(Double(total) / Double(pageSize)))) }
    var canGoPrevious: Bool { page > 0 }
    var canGoNext: Bool { (page + 1) * pageSize < total }

    /// "1–100 of 184", or "0 requests" when nothing matches.
    var rangeDescription: String {
        guard total > 0 else { return "0 requests" }
        let first = page * pageSize + 1
        let last = min(total, (page + 1) * pageSize)
        return "\(first)–\(last) of \(total)"
    }

    // MARK: Lifecycle

    func start() {
        guard stateCancellable == nil else { return }
        stateCancellable = server.$state.sink { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                if state.isRunning {
                    self.refresh()
                } else {
                    self.groups = []
                    self.total = 0
                    self.groupsById.removeAll()
                }
            }
        }
        filterCancellable = $filterText
            .dropFirst()
            .removeDuplicates()
            .debounce(for: .milliseconds(300), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.server.state.isRunning else { return }
                    self.page = 0
                    self.refresh()
                }
            }
        if server.state.isRunning {
            refresh()
        }
    }

    func stop() {
        stateCancellable?.cancel()
        stateCancellable = nil
        filterCancellable?.cancel()
        filterCancellable = nil
        loadTask?.cancel()
        loadTask = nil
        loadGeneration += 1
        isLoading = false
    }

    // MARK: Paging

    func refresh() {
        guard server.state.isRunning else { return }
        loadTask?.cancel()
        loadGeneration += 1
        let generation = loadGeneration
        loadTask = Task { [weak self] in
            await self?.load(generation: generation)
        }
    }

    func goPrevious() {
        guard canGoPrevious else { return }
        page -= 1
        refresh()
    }

    func goNext() {
        guard canGoNext else { return }
        page += 1
        refresh()
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

    private func load(generation: Int) async {
        guard server.state.isRunning else { return }
        isLoading = true
        defer { if generation == loadGeneration { isLoading = false } }
        let offset = page * pageSize
        guard let result = try? await APIClient.getLogEntries(port: server.port, key: server.key, limit: pageSize, offset: offset, search: filterText) else { return }
        guard generation == loadGeneration else { return }
        let lastPage = max(0, Int(ceil(Double(result.total) / Double(pageSize))) - 1)
        if page > lastPage {
            page = lastPage
            return await load(generation: generation)
        }
        // The server returns each page oldest-first; show newest at the top.
        groups = Array(result.groups.reversed())
        total = result.total
        rebuildIndex()
        lastUpdated = Date()
    }

    private func rebuildIndex() {
        groupsById.removeAll()
        for (i, group) in groups.enumerated() {
            groupsById[group.id] = i
        }
    }
}
