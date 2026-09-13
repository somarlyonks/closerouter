/** Zero-dependency validator for the JSON Schema (draft 2020-12) subset used
 *  by the config schema (lib/config/schema.json): local `$ref` (JSON pointers into the root
 *  schema), `type` (single or array), `properties`, `required`,
 *  `additionalProperties` (boolean or schema), `oneOf`, `enum`, `items`,
 *  `minimum`/`maximum`, `minLength`, `minProperties`, and `format: "uri"`.
 *
 *  The macOS app's ConfigValidator mirrors these exact semantics (see the
 *  shared fixtures in test/), so keep both sides in sync when extending the
 *  supported keyword set. Unknown keywords are ignored.
 *
 *  Schema nodes are handled as `Record<string, unknown>` rather than the
 *  exported JSONSchema interface: schema documents arrive from JSON.parse,
 *  and scriptc cannot runtime-cast `unknown` to a recursive interface. The
 *  interface remains as the documented shape for literals and annotations. */

export interface JSONSchema {
    // Schemas carry documentation and other ignored keywords (title,
    // description, default, ...) - keep the surface open so schema documents
    // don't need to be pruned before use.
    [keyword: string]: unknown
    $ref?: string
    type?: string | string[]
    properties?: Record<string, JSONSchema>
    required?: string[]
    additionalProperties?: boolean | JSONSchema
    oneOf?: JSONSchema[]
    enum?: unknown[]
    items?: JSONSchema
    minimum?: number
    maximum?: number
    minLength?: number
    minProperties?: number
    format?: string
    $defs?: Record<string, JSONSchema>
}

export interface SchemaIssue {
    /** Dotted path into the validated value, '' for the root, e.g.
     *  `providers.mock.models[2].id`. */
    path: string
    message: string
}

/** A schema document node: any JSON object, keywords read on demand. */
type SchemaNode = Record<string, unknown>

const MAX_DEPTH = 100
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const URI_WHITESPACE_PATTERN = /\s/

/** Validate `value` against `schema` (a parsed schema document). Returns all
 *  collected issues; an empty array means the value is valid. */
export function validateSchema (schema: unknown, value: unknown): SchemaIssue[] {
    const issues: SchemaIssue[] = []
    if (!isRecord(schema)) {
        issues.push({path: '', message: 'schema is not an object'})
        return issues
    }
    validateNode(schema, schema, value, '', 0, issues)
    return issues
}

/** Return `value` with schema defaults applied: every object property that
 *  is missing from the value and whose subschema declares `default` gets that
 *  default inserted. Recurses through resolved $refs and present properties;
 *  oneOf branches and array items are left untouched (this subset declares no
 *  defaults inside them). Missing values are never invented beyond declared
 *  defaults - validate first so the shape can be trusted. */
export function applySchemaDefaults (schema: unknown, value: unknown): unknown {
    if (!isRecord(schema)) return value
    return applyNode(schema, schema, value, 0)

    function applyNode (root: SchemaNode, node: SchemaNode, value: unknown, depth: number): unknown {
        if (depth > MAX_DEPTH) return value
        const ref = node.$ref
        if (typeof ref === 'string') {
            const target = resolveRef(root, ref)
            return target ? applyNode(root, target, value, depth + 1) : value
        }
        if (Array.isArray(node.oneOf)) return value
        if (!isRecord(value)) return value
        const properties = isRecord(node.properties) ? node.properties : {}
        const valueEntries: [string, unknown][] = []
        for (const [key, present] of Object.entries(value)) valueEntries.push([key, present])
        let out: Record<string, unknown> = Object.fromEntries(valueEntries)
        for (const [key, child] of Object.entries(properties)) {
            if (!isRecord(child)) continue
            if (hasOwn(out, key)) out = setOwn(out, key, applyNode(root, child, out[key], depth + 1))
            else if (child.default !== undefined) out = setOwn(out, key, child.default)
        }
        return out
    }
}

function validateNode (root: SchemaNode, schema: SchemaNode, value: unknown, path: string, depth: number, issues: SchemaIssue[]): void {
    // A $ref that resolves back into itself (directly or through other refs)
    // never consumes input, so without a cap a cyclic schema would recurse
    // forever. 100 is far beyond any real config nesting.
    if (depth > MAX_DEPTH) {
        issues.push({path, message: 'schema recursion limit exceeded'})
        return
    }

    const ref = schema.$ref
    if (typeof ref === 'string') {
        const target = resolveRef(root, ref)
        if (!target) {
            issues.push({path, message: `unresolvable schema reference ${ref}`})
            return
        }
        validateNode(root, target, value, path, depth + 1, issues)
    }

    const oneOf = schema.oneOf
    if (Array.isArray(oneOf)) {
        // Non-object branches of a oneOf (invalid schema) validate trivially,
        // matching the empty-schema behavior.
        validateOneOf(root, oneOf.filter(isRecord), value, path, depth, issues)
    }

    const type = schema.type
    if (!checkType(type, value)) {
        issues.push({path, message: `must be ${describeType(type)}`})
        return // further keywords assume the declared type
    }

    const enumValues = schema.enum
    if (Array.isArray(enumValues) && !enumValues.some(candidate => jsonEqual(candidate, value))) {
        issues.push({path, message: `must be one of: ${enumValues.map(describeValue).join(', ')}`})
    }

    if (typeof value === 'number') {
        const minimum = schema.minimum
        const maximum = schema.maximum
        const below = typeof minimum === 'number' && value < minimum
        const above = typeof maximum === 'number' && value > maximum
        // With both bounds declared one combined message reads better than
        // naming only the violated side ("between 1 and 65535").
        if ((below || above) && typeof minimum === 'number' && typeof maximum === 'number') {
            issues.push({path, message: `must be a number between ${minimum} and ${maximum}`})
        } else if (below) {
            issues.push({path, message: `must be a number >= ${minimum}`})
        } else if (above) {
            issues.push({path, message: `must be a number <= ${maximum}`})
        }
    }

    if (typeof value === 'string') {
        const minLength = schema.minLength
        if (typeof minLength === 'number' && value.length < minLength) {
            issues.push({path, message: `must be at least ${minLength} character${minLength === 1 ? '' : 's'} long`})
        }
        if (schema.format === 'uri' && !isURI(value)) {
            issues.push({path, message: 'must be a valid URI'})
        }
    }

    if (Array.isArray(value)) {
        const items = schema.items
        if (isRecord(items)) {
            value.forEach((item, index) => {
                validateNode(root, items, item, `${path}[${index}]`, depth + 1, issues)
            })
        }
        return
    }

    if (isRecord(value)) {
        const properties = isRecord(schema.properties) ? schema.properties : {}
        const required = Array.isArray(schema.required) ? schema.required.filter(isString) : []
        for (const key of required) {
            if (!hasOwn(value, key)) issues.push({path: propPath(path, key), message: 'is required but missing'})
        }
        for (const [key, child] of Object.entries(properties)) {
            if (hasOwn(value, key) && isRecord(child)) validateNode(root, child, value[key], propPath(path, key), depth + 1, issues)
        }
        const additional = schema.additionalProperties
        for (const key of Object.keys(value)) {
            if (hasOwn(properties, key)) continue
            if (additional === false) issues.push({path: propPath(path, key), message: 'is not an allowed property'})
            else if (isRecord(additional)) validateNode(root, additional, value[key], propPath(path, key), depth + 1, issues)
        }
        const minProperties = schema.minProperties
        if (typeof minProperties === 'number' && Object.keys(value).length < minProperties) {
            issues.push({path, message: `must have at least ${minProperties} ${minProperties === 1 ? 'property' : 'properties'}`})
        }
    }
}

function validateOneOf (root: SchemaNode, branches: SchemaNode[], value: unknown, path: string, depth: number, issues: SchemaIssue[]): void {
    const branchIssues = branches.map((branch) => {
        const collected: SchemaIssue[] = []
        validateNode(root, branch, value, path, depth + 1, collected)
        return collected
    })
    const matches = branchIssues.filter(branch => branch.length === 0).length
    if (matches === 1) return

    if (matches === 0 && branches.length > 0) {
        // Surface why each branch rejected the value so the failure is
        // actionable; one summary issue instead of dumping every branch's tree.
        const reasons = branchIssues
            .map((branch) => {
                const first = branch[0]
                if (!first) return 'no constraints satisfied'
                return first.path && first.path !== path ? `${first.path} ${first.message}` : first.message
            })
            .join('; ')
        issues.push({path, message: `must match one of the allowed shapes (${reasons})`})
    } else if (matches === 0) {
        issues.push({path, message: 'must match one of the allowed shapes'})
    } else {
        issues.push({path, message: `matches more than one allowed shape (${matches} of ${branches.length})`})
    }
}

function resolveRef (root: SchemaNode, ref: string): SchemaNode | undefined {
    if (ref === '#') return root
    if (!ref.startsWith('#/')) return undefined // only local pointers
    let node: unknown = root
    for (const raw of ref.slice(2).split('/')) {
        const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~')
        if (!isRecord(node) || !hasOwn(node, segment)) return undefined
        node = node[segment]
    }
    return isRecord(node) ? node : undefined
}

function checkType (type: unknown, value: unknown): boolean {
    if (Array.isArray(type)) return type.some(candidate => checkType(candidate, value))
    // scriptc does not support switching on unknown, hence the equality chain.
    if (type === 'object') return isRecord(value)
    if (type === 'array') return Array.isArray(value)
    if (type === 'null') return value === null
    if (type === 'boolean') return typeof value === 'boolean'
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
    if (type === 'number') return typeof value === 'number'
    if (type === 'string') return typeof value === 'string'
    return true // absent or unknown type name: never the value's fault
}

function describeType (type: unknown): string {
    const names = (Array.isArray(type) ? type : [type])
        .filter(isString)
        .map(name => (name === 'null' ? 'null' : /^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`))
    return names.length ? names.join(' or ') : 'the declared type'
}

function describeValue (value: unknown): string {
    return JSON.stringify(value) ?? String(value)
}

/** Structural equality for JSON values (enum comparisons). */
function jsonEqual (a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
        return a.every((item, index) => jsonEqual(item, b[index]))
    }
    if (!isRecord(a) || !isRecord(b)) return false
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(key => hasOwn(b, key) && jsonEqual(a[key], b[key]))
}

function isRecord (value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString (value: unknown): value is string {
    return typeof value === 'string'
}

function hasOwn (value: Record<string, unknown>, key: string): boolean {
    return Object.keys(value).includes(key)
}

function setOwn (target: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
    const entries: [string, unknown][] = []
    for (const [existing, present] of Object.entries(target)) {
        if (existing !== key) entries.push([existing, present])
    }
    entries.push([key, value])
    return Object.fromEntries(entries)
}

function isURI (value: string): boolean {
    if (!URI_SCHEME_PATTERN.test(value) || URI_WHITESPACE_PATTERN.test(value)) return false
    try {
        new URL(value)
        return true
    } catch {
        return false
    }
}

function propPath (path: string, key: string): string {
    return path ? `${path}.${key}` : key
}
