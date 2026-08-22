import Foundation

enum APIClientError: LocalizedError {
    case badResponse
    case server(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .badResponse:
            return "Invalid response from the server"
        case .server(_, let message):
            return message
        }
    }
}

/// Minimal HTTP client for the closerouter server's local API.
enum APIClient {
    struct LogEntriesResponse: Decodable {
        let entries: [LogHistoryEntry]
    }

    static func url(port: Int, path: String) -> URL {
        URL(string: "http://127.0.0.1:\(port)/\(path)")!
    }

    /// PUT /config — validates and applies the config server-side.
    static func putConfig(_ raw: String, port: Int, key: String) async throws {
        var req = URLRequest(url: url(port: port, path: "config"))
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.httpBody = Data(raw.utf8)
        req.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIClientError.badResponse }
        guard http.statusCode == 200 else {
            let message = extractError(data) ?? "Server rejected the config (HTTP \(http.statusCode))"
            throw APIClientError.server(status: http.statusCode, message: message)
        }
    }

    /// GET /logs as JSON — historical log entries from the usage DB.
    static func getLogEntries(port: Int, key: String) async throws -> [LogEntry] {
        var req = URLRequest(url: url(port: port, path: "logs"))
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("cr-key=\(key)", forHTTPHeaderField: "Cookie")
        req.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIClientError.badResponse }
        guard http.statusCode == 200 else {
            throw APIClientError.server(status: http.statusCode, message: extractError(data) ?? "Failed to load logs (HTTP \(http.statusCode))")
        }
        let payload = try JSONDecoder().decode(LogEntriesResponse.self, from: data)
        return payload.entries.map(\.asLogEntry)
    }

    private static func extractError(_ data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = obj["error"] as? [String: Any],
              let message = error["message"] as? String else {
            return nil
        }
        return message
    }
}

/// Local validation mirroring closerouter's `parseConfig` rules, so we never
/// write a config that can't boot.
enum ConfigValidator {
    static func validate(_ raw: String) -> String? {
        let data = Data(raw.utf8)
        let obj: Any
        do {
            obj = try JSONSerialization.jsonObject(with: data)
        } catch {
            let err = error as NSError
            let desc = err.userInfo[NSLocalizedDescriptionKey] ?? "Invalid JSON"
            return "Invalid JSON: \(desc)"
        }
        guard let dict = obj as? [String: Any] else {
            return "Config must be a JSON object"
        }
        if let port = dict["port"] as? Int, port < 1 || port > 65535 {
            return "Config \"port\" must be a number between 1 and 65535"
        }
        if let db = dict["db"], !(db is String), !(db is Bool && (db as? Bool) == false) {
            return "Config \"db\" must be a path string, or false to disable"
        }
        guard let providers = dict["providers"] as? [String: Any], !providers.isEmpty else {
            return "Config must contain a non-empty \"providers\" object"
        }
        for (name, value) in providers {
            guard let p = value as? [String: Any] else {
                return "Provider \"\(name)\" must be an object"
            }
            guard let baseURL = p["base_url"] as? String, !baseURL.isEmpty else {
                return "Provider \"\(name)\" is missing \"base_url\""
            }
            guard let apiKey = p["api_key"] as? String, !apiKey.isEmpty else {
                return "Provider \"\(name)\" is missing \"api_key\""
            }
            if let models = p["models"], !(models is [Any]) {
                return "Provider \"\(name)\" \"models\" must be an array"
            }
        }
        return nil
    }
}
