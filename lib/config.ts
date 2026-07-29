import {readFileSync, existsSync} from 'fs'
import {join, resolve} from 'path'

export interface ModelEntry {
    // id with provider prefix, e.g. "deepseek/deepseek-v4-flash"
    id: string
    object?: string
    created?: number
    owned_by?: string
}

export type ModelConfig = string | ModelEntry

export interface ProviderConfig {
    base_url: string
    api_key: string
    models: ModelConfig[]
}

export interface Config {
    port: number
    key?: string
    providers: Record<string, ProviderConfig>
}

export function resolveConfigPath (): string {
    const cliPath = process.argv.length > 2 ? process.argv[2] : undefined
    if (cliPath) return resolve(process.cwd(), cliPath)

    return join(process.cwd(), 'closerouter.json')
}

export function loadConfig (configPath?: string): Config {
    const path = configPath ?? resolveConfigPath()

    if (!existsSync(path)) exitFor(`Config file not found: ${path}`)

    let raw: string
    try {
        const buf = readFileSync(path)
        raw = buf.toString('utf-8')
    } catch {
        exitFor(`Failed to read config file: ${path}`)
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        exitFor(`Invalid JSON in config file: ${path}`)
    }

    const config = parsed as Config

    if (config.port && (typeof config.port !== 'number' || config.port < 1 || config.port > 65535)) {
        exitFor('Config "port" must be a number between 1 and 65535')
    }

    if (typeof config?.providers !== 'object') exitFor('Config must contain a "providers" object')
    if (!Object.keys(config.providers).length) exitFor('Config must have at least one provider')

    for (const [name, provider] of Object.entries(config.providers)) {
        if (!provider.base_url) exitFor(`Provider "${name}" is missing "base_url"`)
        if (!provider.api_key) exitFor(`Provider "${name}" is missing "api_key"`)
    }

    return {
        port: config.port ?? 6712,
        key: config.key,
        providers: config.providers,
    }
}

function exitFor (reason: string): never {
    console.error(reason)
    process.exit(1)
}
