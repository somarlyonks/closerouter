import {readFileSync, existsSync} from 'fs'

export type ModelConfig = string | {id: string}

export interface ProviderConfig {
    base_url: string
    api_key: string
    models?: ModelConfig[]
}

export interface Config {
    $schema?: string
    port?: number
    key?: string
    providers: Record<string, ProviderConfig>
}

export interface RuntimeConfig {
    raw: string
    path: string
    port: number
    key: string
    providers: Record<string, ProviderConfig>
}

const DEFAULT_PORT = 6712
const DEFAULT_KEY = 'sk-cr-kee9itsecr1t'

export function parseConfig (raw: string): Omit<RuntimeConfig, 'path'> {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error('Invalid JSON in config')
    }

    if (typeof parsed !== 'object' || !parsed) throw new Error('Config must be a JSON object')

    const obj = parsed as Record<string, unknown>

    if (obj.port !== undefined && (typeof obj.port !== 'number' || obj.port < 1 || obj.port > 65535)) {
        throw new Error('Config "port" must be a number between 1 and 65535')
    }

    if (typeof obj.providers !== 'object' || !obj.providers) {
        throw new Error('Config must contain a "providers" object')
    }

    const providers = obj.providers as Record<string, unknown>
    if (!Object.keys(providers).length) {
        throw new Error('Config must have at least one provider')
    }

    const normalized: Config['providers'] = {}

    for (const [name, provider] of Object.entries(providers)) {
        if (typeof provider !== 'object' || !provider) {
            throw new Error(`Provider "${name}" must be an object`)
        }
        const p = provider as Record<string, unknown>
        if (typeof p.base_url !== 'string' || !p.base_url) {
            throw new Error(`Provider "${name}" is missing "base_url"`)
        }
        if (typeof p.api_key !== 'string' || !p.api_key) {
            throw new Error(`Provider "${name}" is missing "api_key"`)
        }
        if (p.models && !Array.isArray(p.models)) {
            throw new Error(`Provider "${name}" "models" must be an array`)
        }
        normalized[name] = {
            base_url: p.base_url,
            api_key: p.api_key,
            models: p.models as ModelConfig[] | undefined,
        }
    }

    return {
        raw,
        port: typeof obj.port === 'number' ? obj.port : DEFAULT_PORT,
        key: typeof obj.key === 'string' ? obj.key : DEFAULT_KEY,
        providers: normalized,
    }
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
        return Object.assign({}, parseConfig(raw), {path: configPath})
    } catch (e) {
        exitFor(e instanceof Error ? e.message : String(e))
    }
}

export function applyConfig (store: RuntimeConfig, config: Omit<RuntimeConfig, 'path'>): void {
    store.port = config.port
    store.key = config.key
    store.providers = config.providers
}

export function printServerConfig (config: RuntimeConfig) {
    console.log(`closerouter running on http://localhost:${config.port}`)
    console.log(`API key: ${config.key}`)
    console.log(`Providers:`)
    for (const p of Object.keys(config.providers)) console.log(`  ${p}`)
}

function exitFor (reason: string): never {
    console.error(reason)
    process.exit(1)
}
