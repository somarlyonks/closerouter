import Foundation

/// Reads and manages the closerouter config file in Application Support.
enum ConfigStore {
    static let appSupportDirectory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("CloseRouter", isDirectory: true)
    }()

    static var configURL: URL {
        appSupportDirectory.appendingPathComponent("closerouter.json")
    }

    static let defaultPort = 6712
    static let runtimeDefaultKey = "sk-cr-kee9itsecr1t"

    /// Creates the config directory and a default config file when missing.
    static func ensureConfigFile() throws {
        try FileManager.default.createDirectory(at: appSupportDirectory, withIntermediateDirectories: true)
        guard !FileManager.default.fileExists(atPath: configURL.path) else { return }
        try DefaultConfig.make().write(to: configURL, atomically: true, encoding: .utf8)
    }

    static func read() throws -> (port: Int, key: String) {
        let data = try Data(contentsOf: configURL)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let port = obj["port"] as? Int ?? defaultPort
        let key = (obj["key"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? runtimeDefaultKey
        return (port, key)
    }

    /// Persists a raw config string to disk.
    static func save(_ raw: String) throws {
        try raw.write(to: configURL, atomically: true, encoding: .utf8)
    }

    /// Extracts the port from a raw config string.
    static func port(of raw: String) throws -> Int {
        let obj = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
        return obj?["port"] as? Int ?? defaultPort
    }
}

/// Seeds the default config on first launch from the bundled repo-level closerouter.json.
enum DefaultConfig {
    static func make() -> String {
        guard let url = Bundle.main.url(forResource: "closerouter", withExtension: "json"),
              let raw = try? String(contentsOf: url, encoding: .utf8) else {
            return """
            {
                "$schema": "https://raw.githubusercontent.com/somarlyonks/closerouter/refs/tags/v\(UpdateChecker.currentVersion)/closerouter-schema.json",
                "port": \(ConfigStore.defaultPort),
                "key": "\(ConfigStore.runtimeDefaultKey)",
                "providers": {}
            }
            """
        }
        return raw
    }
}
