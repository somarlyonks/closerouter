import {readFileSync, existsSync} from 'fs'
import {resolve, dirname} from 'path'
import {createHash} from 'crypto'
import {validateSchema, applySchemaDefaults, type SchemaIssue} from './json-schema'
import {json as schema} from './schema.json.ts'

export interface ModelConfigObject {
    [key: string]: unknown
    id: string
}

export type ModelConfig = string | ModelConfigObject

export interface ProviderConfig {
    base_url: string
    api_key: string
    models?: ModelConfig[]
}

export interface Config {
    $schema?: string
    port?: number
    key?: string
    db?: string | false
    retentionDays?: number
    providers: Record<string, ProviderConfig>
}

export interface RuntimeConfig {
    port: number
    key: string
    dbPath: string | undefined
    retentionDays: number
    providers: Record<string, ProviderConfig>
    /** SHA-256 of the exact config document the runtime was loaded from -
     *  lets a client confirm the running server reflects the config it saved.
     *  Absent for programmatically built configs. */
    hash?: string
    /** absent for programmatically built configs */
    path?: string
}

/** Fingerprint the exact config document (before any secret merge or schema
 *  defaulting), so a client can hash the same bytes it persisted. */
export function hashConfig (raw: string): string {
    return createHash('sha256').update(raw).digest('hex')
}

export function mapProviders<In, Out> (
    providers: Record<string, In>,
    project: (name: string, provider: In) => Out | undefined,
): Record<string, Out> {
    const entries: [string, Out][] = []
    for (const name of Object.keys(providers)) {
        const projected = project(name, providers[name])
        if (projected !== undefined) entries.push([name, projected])
    }
    return Object.fromEntries(entries)
}

/** Parse and validate a config document. Shape, constraints, and defaults all
 *  come from the embedded schema.json (via validateSchema /
 *  applySchemaDefaults); the only remaining work is the typed projection into
 *  RuntimeConfig. Runtime-only normalization (resolving the db path against
 *  the config file's directory) lives in loadConfig, which knows the path. */
export function parseConfig (raw: string): RuntimeConfig {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error('Invalid JSON in config')
    }

    const issues = validateSchema(schema, parsed)
    if (issues.length) throw new Error(formatIssues(issues))

    const config = applySchemaDefaults(schema, parsed) as Record<string, unknown>

    const providers = mapProviders(
        config.providers as Record<string, Record<string, unknown>>,
        (_name, p): ProviderConfig => ({
            base_url: p.base_url as string,
            api_key: p.api_key as string,
            models: p.models as ModelConfig[] | undefined,
        }),
    )

    return {
        port: config.port as number,
        key: config.key as string,
        dbPath: config.db === false ? undefined : config.db as string,
        retentionDays: config.retentionDays as number,
        providers,
    }
}

function formatIssues (issues: SchemaIssue[]): string {
    return issues
        .map(issue => (issue.path ? `"${issue.path}" ${issue.message}` : issue.message))
        .join('; ')
}

/** Resolve a config db path in place: relative paths resolve against the
 *  config file's directory, and SQLite special filenames (`:memory:`,
 *  `file:` URIs) pass through unchanged. Shared by boot (loadConfig) and the
 *  PUT /config handler so both produce identical paths. */
export function resolveDbPath (dbPath: RuntimeConfig['dbPath'], configPath: string | undefined): RuntimeConfig['dbPath'] {
    if (dbPath === undefined) return dbPath
    if (dbPath === ':memory:' || dbPath.startsWith('file:')) return dbPath
    return resolve(dirname(configPath ?? '.'), dbPath)
}

export function loadConfig (configPath: string): RuntimeConfig {
    if (!existsSync(configPath)) exitFor(`Config file not found: ${configPath}`)

    let raw: string
    try {
        const buf = readFileSync(configPath)
        raw = buf.toString('utf-8')
    } catch {
        exitFor(`Failed to read config file: ${configPath}`)
    }

    try {
        const config = parseConfig(raw)
        config.dbPath = resolveDbPath(config.dbPath, configPath)
        config.hash = hashConfig(raw)
        return {...config, path: configPath}
    } catch (e) {
        exitFor(e instanceof Error ? e.message : String(e))
    }
}

export function applyConfig (store: RuntimeConfig, config: RuntimeConfig): void {
    store.key = config.key
    store.providers = config.providers
    store.hash = config.hash
}

export function printServerConfig (config: RuntimeConfig, host = '127.0.0.1') {
    console.log(`closerouter running on http://${host}:${config.port}`)
    console.log(`API key: ${config.key}`)
    console.log(`Providers:`)
    for (const p of Object.keys(config.providers)) console.log(`  ${p}`)
}

function exitFor (reason: string): never {
    console.error(reason)
    process.exit(1)
}
