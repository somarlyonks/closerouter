import {readFileSync, existsSync} from 'fs'
import {resolve, dirname} from 'path'
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

    const providerEntries: [string, ProviderConfig][] = []
    for (const [name, provider] of Object.entries(config.providers as Record<string, unknown>)) {
        const p = provider as Record<string, unknown>
        providerEntries.push([name, {
            base_url: p.base_url as string,
            api_key: p.api_key as string,
            models: p.models as ModelConfig[] | undefined,
        }])
    }
    const providers: Record<string, ProviderConfig> = Object.fromEntries(providerEntries)

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
        // Relative filesystem paths resolve against the config file's directory;
        // SQLite special filenames must pass through unchanged.
        if (config.dbPath !== undefined && config.dbPath !== ':memory:' && !config.dbPath.startsWith('file:')) {
            config.dbPath = resolve(dirname(configPath), config.dbPath)
        }
        return Object.assign({}, config, {path: configPath})
    } catch (e) {
        exitFor(e instanceof Error ? e.message : String(e))
    }
}

export function applyConfig (store: RuntimeConfig, config: Omit<RuntimeConfig, 'path'>): void {
    store.key = config.key
    store.providers = config.providers
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
