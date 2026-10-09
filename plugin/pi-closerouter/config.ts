import {join} from 'node:path'
import type {ModelOverride} from './models.ts'
import {asRecord, numberField, parseJson, stringField} from './values.ts'

/** A model to expose: a bare id, or an object whose fields override pi's specs. */
export type ConfiguredModel = ModelOverride & {id: string}

export interface CloserouterSettings {
    baseUrl: string
    apiKey: string
    /** Models pi exposes; empty exposes every model the gateway reports. */
    models: ConfiguredModel[]
}

export interface ConfigSources {
    env: Record<string, string | undefined>
    cwd: string
    homeDir: string
    readText: (filePath: string) => string | undefined
}

const DEFAULT_PORT = 6712
const DEFAULT_KEY = 'sk-cr-kee9itsecr1t'
const SETTINGS_FILE = 'settings.json'
const SETTINGS_FIELD = 'closerouter'

// resolveSettings reads, in order: explicit environment, the `closerouter` field
// of pi's settings.json, then the port and key a running closerouter was started
// with, then the built-in defaults. The settings field also carries model overrides.
export function resolveSettings (sources: ConfigSources): CloserouterSettings {
    const server = readServerConfig(sources)
    const plugin = readPluginSettings(sources)
    const port = server?.port ?? DEFAULT_PORT
    const baseUrl = normalizeBaseUrl(
        sources.env.CLOSEROUTER_URL
        ?? stringField(plugin, 'baseUrl')
        ?? `http://127.0.0.1:${port}`,
    )
    const apiKey = sources.env.CLOSEROUTER_KEY
        ?? stringField(plugin, 'apiKey')
        ?? server?.key
        ?? DEFAULT_KEY
    return {
        baseUrl,
        apiKey,
        models: parseConfiguredModels(plugin?.models),
    }
}

// parseConfiguredModels reads the `models` array of pi's settings: each entry is
// a bare id string or an object whose `id` and override fields pi merges over
// the collected specs.
function parseConfiguredModels (value: unknown): ConfiguredModel[] {
    if (!Array.isArray(value)) return []
    const models: ConfiguredModel[] = []
    for (const item of value) {
        if (typeof item === 'string' && item.length > 0) {
            models.push({id: item})
            continue
        }
        const record = asRecord(item)
        const id = stringField(record, 'id')
        if (id) models.push({...record, id} as unknown as ConfiguredModel)
    }
    return models
}

// resolveAgentDir is pi's agent directory, where it keeps settings.json.
export function resolveAgentDir (sources: Pick<ConfigSources, 'env' | 'homeDir'>): string {
    return sources.env.PI_CODING_AGENT_DIR ?? join(sources.homeDir, '.pi', 'agent')
}

// normalizeBaseUrl accepts a bare host:port or a full URL, with or without the
// /v1 suffix, and always answers the OpenAI base closerouter serves.
export function normalizeBaseUrl (raw: string): string {
    const value = raw.trim() || `http://127.0.0.1:${DEFAULT_PORT}`
    const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`
    const trimmed = withScheme.replace(/\/+$/, '')
    return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
}

function readServerConfig (sources: ConfigSources): {port?: number, key?: string} | undefined {
    for (const candidate of serverConfigCandidates(sources)) {
        const parsed = asRecord(parseJson(sources.readText(candidate)))
        if (parsed) return {port: numberField(parsed, 'port'), key: stringField(parsed, 'key')}
    }
    return undefined
}

function serverConfigCandidates (sources: ConfigSources): string[] {
    return [
        sources.env.CLOSEROUTER_CONFIG,
        join(sources.cwd, 'closerouter.json'),
        join(sources.homeDir, 'Library', 'Application Support', 'CloseRouter', 'closerouter.json'),
        join(sources.homeDir, '.config', 'closerouter', 'closerouter.json'),
    ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
}

// readPluginSettings is the `closerouter` field of pi's settings.json.
function readPluginSettings (sources: ConfigSources): Record<string, unknown> | undefined {
    const settings = asRecord(parseJson(sources.readText(join(resolveAgentDir(sources), SETTINGS_FILE))))
    return asRecord(settings?.[SETTINGS_FIELD])
}
