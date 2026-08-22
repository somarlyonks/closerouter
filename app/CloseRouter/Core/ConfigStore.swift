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

    /// Creates the config directory and a default config file when missing.
    static func ensureConfigFile() throws {
        try FileManager.default.createDirectory(at: appSupportDirectory, withIntermediateDirectories: true)
        guard !FileManager.default.fileExists(atPath: configURL.path) else { return }
        try DefaultConfig.make().write(to: configURL, atomically: true, encoding: .utf8)
    }

    /// Port and key as currently configured on disk.
    static func read() throws -> (port: Int, key: String) {
        let data = try Data(contentsOf: configURL)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let port = obj["port"] as? Int ?? 6712
        let key = obj["key"] as? String ?? "sk-cr-kee9itsecr1t"
        return (port, key)
    }

    /// Persists a raw config string to disk.
    static func save(_ raw: String) throws {
        try raw.write(to: configURL, atomically: true, encoding: .utf8)
    }

    /// Extracts the port from a raw config string.
    static func port(of raw: String) throws -> Int {
        let obj = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
        return obj?["port"] as? Int ?? 6712
    }
}

/// Generates the default config written on first launch.
enum DefaultConfig {
    static func make() -> String {
        """
        {
            "$schema": "https://raw.githubusercontent.com/somarlyonks/closerouter/refs/heads/master/closerouter-schema.json",
            "port": 6712,
            "key": "sk-cr-\(randomToken())",
            "db": "closerouter.db",
            "providers": {
                "example": {
                    "base_url": "https://api.openai.com/v1",
                    "api_key": "YOUR_API_KEY",
                    "models": [
                        "gpt-4o-mini"
                    ]
                }
            }
        }
        """
    }

    private static func randomToken() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }
}
