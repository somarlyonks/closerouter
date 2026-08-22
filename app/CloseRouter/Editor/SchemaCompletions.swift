import Foundation

// MARK: - Schema model

/// Minimal JSON Schema model covering what closerouter-schema.json uses:
/// object properties, required, items, enum, oneOf, additionalProperties and $ref/$defs.
final class JSONSchema {
    var type: String?
    var description: String?
    var defaultValue: Any?
    var properties: [String: JSONSchema] = [:]
    var required: Set<String> = []
    var items: JSONSchema?
    var enumValues: [Any]?
    var oneOf: [JSONSchema]?
    var additionalProperties: JSONSchema?
    var ref: String?

    init(json: [String: Any]) {
        type = json["type"] as? String
        description = json["description"] as? String
        defaultValue = json["default"]
        if let p = json["properties"] as? [String: Any] {
            for (k, v) in p {
                if let dict = v as? [String: Any] {
                    properties[k] = JSONSchema(json: dict)
                }
            }
        }
        if let r = json["required"] as? [String] { required = Set(r) }
        if let i = json["items"] as? [String: Any] { items = JSONSchema(json: i) }
        if let e = json["enum"] as? [Any] { enumValues = e }
        if let one = json["oneOf"] as? [[String: Any]] { oneOf = one.map { JSONSchema(json: $0) } }
        if let ap = json["additionalProperties"] as? [String: Any] { additionalProperties = JSONSchema(json: ap) }
        if let ref = json["$ref"] as? String { self.ref = ref }
    }

    /// Follows `#/$defs/<name>` references.
    func resolved() -> JSONSchema {
        guard let ref, ref.hasPrefix("#/$defs/") else { return self }
        let name = String(ref.dropFirst("#/$defs/".count))
        return JSONSchemaStore.defs[name]?.resolved() ?? self
    }
}

enum JSONSchemaStore {
    static private(set) var root: JSONSchema?
    static private(set) var defs: [String: JSONSchema] = [:]

    static func ensureLoaded() {
        guard root == nil else { return }
        guard let url = Bundle.main.url(forResource: "closerouter-schema", withExtension: "json") else { return }
        _ = load(from: url)
    }

    @discardableResult
    static func load(from url: URL) -> Bool {
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        defs.removeAll()
        if let d = json["$defs"] as? [String: Any] {
            for (k, v) in d {
                if let dict = v as? [String: Any] {
                    defs[k] = JSONSchema(json: dict)
                }
            }
        }
        root = JSONSchema(json: json)
        return true
    }
}

// MARK: - Completion

struct CompletionItem {
    let label: String
    let insertText: String
    let detail: String?
    let isRequired: Bool

    init(label: String, detail: String? = nil, isRequired: Bool = false, isQuoted: Bool = false) {
        self.label = label
        self.detail = detail
        self.isRequired = isRequired
        self.insertText = isQuoted ? "\"\(label)\"" : label
    }
}

enum ConfigCompletionEngine {
    struct Context {
        enum Position {
            case objectKey
            case propertyValue(key: String)
            case arrayItem
        }
        let position: Position
        let path: [String]
        let partial: String
    }

    static func completions(in text: String, cursor: Int) -> [CompletionItem] {
        JSONSchemaStore.ensureLoaded()
        guard let root = JSONSchemaStore.root else { return [] }
        let ctx = analyze(text, cursor: cursor)
        let partial = ctx.partial.lowercased()

        switch ctx.position {
        case .objectKey:
            guard let schema = resolve(root, path: ctx.path) else { return [] }
            var items: [CompletionItem] = []
            for (name, prop) in schema.properties {
                guard partial.isEmpty || name.lowercased().hasPrefix(partial) else { continue }
                let required = schema.required.contains(name)
                let detail = [prop.type, prop.description].compactMap { $0 }.joined(separator: " · ")
                items.append(CompletionItem(
                    label: name,
                    detail: detail.isEmpty ? nil : detail,
                    isRequired: required,
                    isQuoted: true
                ))
            }
            items.sort { ($0.isRequired ? 0 : 1, $0.label) < ($1.isRequired ? 0 : 1, $1.label) }
            return items
        case .propertyValue(let key):
            guard let schema = resolve(root, path: ctx.path)?.properties[key]?.resolved() else { return [] }
            return valueCompletions(for: schema)
        case .arrayItem:
            guard let schema = resolve(root, path: ctx.path)?.resolved(),
                  let itemsSchema = schema.items?.resolved() else { return [] }
            return valueCompletions(for: itemsSchema)
        }
    }

    private static func valueCompletions(for schema: JSONSchema) -> [CompletionItem] {
        var items: [CompletionItem] = []
        if let enums = schema.enumValues {
            // An enum is authoritative — don't also offer type-based suggestions.
            for v in enums {
                if let s = v as? String {
                    items.append(CompletionItem(label: s, detail: "enum", isQuoted: true))
                } else if let b = v as? NSNumber, CFGetTypeID(b) == CFBooleanGetTypeID() {
                    items.append(CompletionItem(label: b.boolValue ? "true" : "false", detail: "enum"))
                } else {
                    items.append(CompletionItem(label: "\(v)", detail: "enum"))
                }
            }
        } else {
            switch schema.type {
            case "boolean":
                items.append(contentsOf: [
                    CompletionItem(label: "true"),
                    CompletionItem(label: "false"),
                ])
            case "string":
                if let d = schema.defaultValue as? String {
                    items.append(CompletionItem(label: d, detail: "default", isQuoted: true))
                } else {
                    items.append(CompletionItem(label: "", detail: "string", isQuoted: true))
                }
            case "integer", "number":
                if let d = schema.defaultValue {
                    items.append(CompletionItem(label: "\(d)", detail: "default"))
                }
            default:
                break
            }
        }
        if let oneOf = schema.oneOf {
            for variant in oneOf {
                for item in valueCompletions(for: variant.resolved()) {
                    if !items.contains(where: { $0.label == item.label && $0.insertText == item.insertText }) {
                        items.append(item)
                    }
                }
            }
        }
        return items
    }

    /// Traverses object keys (following additionalProperties for free-form names).
    private static func resolve(_ schema: JSONSchema, path: [String]) -> JSONSchema? {
        var current = schema
        for key in path {
            let c = current.resolved()
            if let next = c.properties[key] {
                current = next
            } else if let add = c.additionalProperties {
                current = add
            } else {
                return nil
            }
        }
        return current.resolved()
    }

    /// Scans the text up to `cursor` to figure out where we are (key/value/array)
    /// and the path of enclosing objects.
    static func analyze(_ text: String, cursor: Int) -> Context {
        let chars = Array(text)
        var i = 0
        var inString = false
        var stringBuffer = ""
        var pendingKey: String?
        var lastKeyInObject: String?
        var stack: [(isArray: Bool, key: String?)] = []

        while i < cursor, i < chars.count {
            let c = chars[i]
            if inString {
                if c == "\\" {
                    i += 2
                    continue
                }
                if c == "\"" {
                    inString = false
                    pendingKey = stringBuffer
                    stringBuffer = ""
                } else {
                    stringBuffer.append(c)
                }
                i += 1
                continue
            }
            switch c {
            case "\"":
                inString = true
                stringBuffer = ""
            case "{":
                stack.append((false, pendingKey ?? lastKeyInObject))
                pendingKey = nil
                lastKeyInObject = nil
            case "[":
                stack.append((true, pendingKey ?? lastKeyInObject))
                pendingKey = nil
            case "}":
                if !stack.isEmpty { stack.removeLast() }
            case "]":
                if !stack.isEmpty { stack.removeLast() }
            case ":":
                if let pk = pendingKey { lastKeyInObject = pk }
                pendingKey = nil
            case ",":
                pendingKey = nil
            default:
                break
            }
            i += 1
        }

        // Partial word at the cursor.
        var start = cursor
        while start > 0 {
            let c = chars[start - 1]
            if c.isLetter || c.isNumber || c == "_" || c == "-" || c == "." || c == "$" {
                start -= 1
            } else {
                break
            }
        }
        let partial = String(chars[start..<min(cursor, chars.count)])

        // Significant character before the partial word.
        var p = start
        while p > 0, chars[p - 1] == " " || chars[p - 1] == "\t" || chars[p - 1] == "\n" || chars[p - 1] == "\r" {
            p -= 1
        }
        let prev = p > 0 ? chars[p - 1] : nil
        let path = stack.compactMap { $0.key }

        let position: Context.Position
        if prev == ":" {
            position = .propertyValue(key: lastKeyInObject ?? "")
        } else if prev == "\"" {
            // Inside a quoted token — decide key vs value by scanning back for ':' vs '{'/','/'['.
            var q = p - 1
            var result: Context.Position = .objectKey
            while q >= 0 {
                let c = chars[q]
                if c == ":" {
                    result = .propertyValue(key: lastKeyInObject ?? "")
                    break
                }
                if c == "{" || c == "," {
                    result = (stack.last?.isArray ?? false) ? .arrayItem : .objectKey
                    break
                }
                if c == "[" {
                    result = .arrayItem
                    break
                }
                q -= 1
            }
            position = result
        } else if prev == "{" || prev == "," {
            position = (stack.last?.isArray ?? false) ? .arrayItem : .objectKey
        } else if prev == "[" {
            position = .arrayItem
        } else {
            position = .objectKey
        }

        return Context(position: position, path: path, partial: partial)
    }
}
