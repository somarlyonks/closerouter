import type {ServerResponse} from 'http'
import {parseConfig, applyConfig, resolveDbPath, displayDbPath, mapProviders, hashConfig, type RuntimeConfig, type ProviderConfig} from '../../config'
import {router, method, needsAuth, withMethod, handleBadRequest, respondError, readRequestBody} from '../../router'
import {applyModelAliases} from '../logs/db'

/** The config as served to clients: no raw document, no provider api_keys,
 *  and db exposed under its config-document name (the resolved path, the
 *  remote endpoint without its key, or false when persistence is disabled). */
interface PublicConfig {
    port: number
    key: string
    db: string | false
    retentionDays: number
    alias: Record<string, string>
    providers: Record<string, Record<string, unknown>>
}

/** Boot-only fields: a document that changes one takes effect on the next
 *  boot, so a supervisor has to restart the process. */
type BootOnlyField = 'port' | 'db' | 'retentionDays'

/** The PUT /config echo: the applied config plus the boot-only fields the
 *  submitted document changed. */
interface ConfigUpdate extends PublicConfig {
    restartRequired: BootOnlyField[]
}

function stripConfigApiKey (config: RuntimeConfig): PublicConfig {
    const providers = mapProviders(config.providers, (_name, provider): Record<string, unknown> => ({
        base_url: provider.base_url,
        models: provider.models || [],
    }))

    return {
        port: config.port,
        key: config.key,
        db: displayDbPath(config.dbPath) ?? false,
        retentionDays: config.retentionDays,
        alias: config.alias,
        providers,
    }
}

function sendConfigResponse (res: ServerResponse, payload: PublicConfig | ConfigUpdate): void {
    res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload, null, 2))
}

function bootOnlyChanges (running: RuntimeConfig, next: RuntimeConfig): {field: BootOnlyField, message: string}[] {
    const changes: {field: BootOnlyField, message: string}[] = []
    if (next.port !== running.port) {
        changes.push({field: 'port', message: `config port changed ${running.port} -> ${next.port}; restart for the new port to take effect`})
    }
    if (next.dbPath !== running.dbPath) {
        changes.push({field: 'db', message: `config db changed ${displayDbPath(running.dbPath) ?? '(disabled)'} -> ${displayDbPath(next.dbPath) ?? '(disabled)'}; restart for the new db to take effect`})
    }
    if (next.retentionDays !== running.retentionDays) {
        changes.push({field: 'retentionDays', message: `config retentionDays changed ${running.retentionDays} -> ${next.retentionDays}; restart for the new retention policy to take effect`})
    }
    return changes
}

function mergeProviderSecrets (raw: string, stored: Record<string, ProviderConfig>): string {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return raw // invalid JSON - parseConfig produces the error
    }
    if (typeof parsed !== 'object' || !parsed) return raw
    const obj = parsed as Record<string, unknown>
    if (typeof obj.providers !== 'object' || !obj.providers) return raw

    const providers = mapProviders(obj.providers as Record<string, unknown>, (name, provider): Record<string, unknown> | undefined => {
        if (typeof provider !== 'object' || !provider) return undefined
        const p = provider as Record<string, unknown>
        const copy: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(p)) copy[k] = v
        if ((p.api_key === undefined || p.api_key === '') && Object.keys(stored).includes(name)) {
            copy.api_key = stored[name].api_key
        }
        return copy
    })

    const merged: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) merged[k] = v
    merged.providers = providers
    return JSON.stringify(merged)
}

export const handleConfig = router(
    method('GET'),
    needsAuth((ctx, res) => sendConfigResponse(res, stripConfigApiKey(ctx.env.config))),
    withMethod('PUT')(needsAuth(
        (ctx, res) => {
            readRequestBody(ctx).then((raw) => {
                let config: RuntimeConfig
                try {
                    config = parseConfig(mergeProviderSecrets(raw, ctx.env.config.providers))
                    config.dbPath = resolveDbPath(config.dbPath, ctx.env.config.path)
                    config.hash = hashConfig(raw)
                } catch (e) {
                    return handleBadRequest(res, e instanceof Error ? e.message : 'Invalid config')
                }

                const changes = bootOnlyChanges(ctx.env.config, config)
                applyConfig(ctx.env.config, config)
                applyModelAliases(config.alias)
                ctx.env.modelsCache?.invalidate()

                for (const change of changes) console.log(change.message)

                sendConfigResponse(res, {...stripConfigApiKey(config), restartRequired: changes.map(change => change.field)})
            })
            ctx.req.on('error', (err: Error) => {
                if (!res.headersSent) respondError(res, 400, 'client_error', `Failed to read request: ${err.message}`)
            })
        },
    )),
)
