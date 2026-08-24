import Foundation

/// Checks GitHub releases for a newer CloseRouter version.
@MainActor
final class UpdateChecker: ObservableObject {
    enum State: Equatable {
        case idle
        case checking
        case upToDate
        case available(version: String, url: String, notes: String?)
        case failed(String)

        var isChecking: Bool {
            if case .checking = self { return true }
            return false
        }
    }

    struct Release: Decodable {
        let tagName: String
        let htmlURL: String
        let name: String?
        let body: String?

        enum CodingKeys: String, CodingKey {
            case tagName = "tag_name"
            case htmlURL = "html_url"
            case name
            case body
        }

        /// Tag without the conventional "v" prefix.
        var versionNumber: String {
            tagName.drop(while: { $0 == "v" || $0 == "V" }).description
        }
    }

    static let shared = UpdateChecker()
    static let repo = "somarlyonks/closerouter"
    private static let latestReleaseURL = URL(string: "https://api.github.com/repos/\(repo)/releases/latest")!

    @Published private(set) var state: State = .idle

    static var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    private init() {}

    func check() async {
        guard !state.isChecking else { return }
        state = .checking
        do {
            let release = try await Self.fetchLatestRelease()
            if Self.isVersion(release.versionNumber, newerThan: Self.currentVersion) {
                state = .available(version: release.tagName, url: release.htmlURL, notes: release.body)
                if Preferences.notificationsEnabled && Preferences.checkForUpdatesAutomatically {
                    AppNotifications.post(
                        title: "CloseRouter update available",
                        body: "\(release.tagName) is out — you're on v\(Self.currentVersion)."
                    )
                }
            } else {
                state = .upToDate
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Fire-and-forget check used on app launch.
    func checkInBackground() {
        Task { [weak self] in
            await self?.check()
        }
    }

    // MARK: GitHub API

    private nonisolated static func fetchLatestRelease() async throws -> Release {
        var request = URLRequest(url: latestReleaseURL)
        request.timeoutInterval = 10
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard http.statusCode == 200 else {
            throw URLError(URLError.Code(rawValue: http.statusCode))
        }
        return try JSONDecoder().decode(Release.self, from: data)
    }

    /// Numeric dot-component comparison ("1" < "2" < "2.1" < "2.10"); non-numeric suffixes ignored.
    static func isVersion(_ candidate: String, newerThan current: String) -> Bool {
        let lhs = numericComponents(candidate)
        let rhs = numericComponents(current)
        for i in 0..<max(lhs.count, rhs.count) {
            let l = i < lhs.count ? lhs[i] : 0
            let r = i < rhs.count ? rhs[i] : 0
            if l != r { return l > r }
        }
        return false
    }

    private static func numericComponents(_ version: String) -> [Int] {
        version.split(separator: ".").map { comp in
            Int(comp.prefix(while: \.isNumber)) ?? 0
        }
    }
}
