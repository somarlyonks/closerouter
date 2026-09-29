import {parseConfig, applyConfig, resolveDbPath, mapProviders, type RuntimeConfig, type ProviderConfig} from '../../config'
import {router, method, needsAuth, withMethod, handleHTML, handleBadRequest, respondError, readRequestBody} from '../../router'
import {html as indexHTML} from './index.html'

/** The config as served to clients: no raw document, no provider api_keys,
 *  and db exposed under its config-document name (the resolved path, or false
 *  when persistence is disabled). */
interface PublicConfig {
    port: number
    key: string
    db: string | false
    retentionDays: number
    providers: Record<string, Record<string, unknown>>
}

function stripConfigApiKey (config: RuntimeConfig): PublicConfig {
    const providers = mapProviders(config.providers, (_name, provider): Record<string, unknown> => ({
        base_url: provider.base_url,
        models: provider.models || [],
    }))

    return {
        port: config.port,
        key: config.key,
        db: config.dbPath ?? false,
        retentionDays: config.retentionDays,
        providers,
    }
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
    router(
        c => !!c.req.headers['accept']?.includes('application/json'),
        needsAuth((ctx, res) => {
            res.writeHead(200, {
                'content-type': 'application/json',
            })
            res.end(JSON.stringify(stripConfigApiKey(ctx.env.config), undefined, 2))
        }),
        handleHTML(indexHTML),
    ),
    withMethod('PUT')(needsAuth(
        (ctx, res) => {
            readRequestBody(ctx).then((raw) => {
                let config: RuntimeConfig
                try {
                    config = parseConfig(mergeProviderSecrets(raw, ctx.env.config.providers))
                    config.dbPath = resolveDbPath(config.dbPath, ctx.env.config.path)
                } catch (e) {
                    return handleBadRequest(res, e instanceof Error ? e.message : 'Invalid config')
                }

                const previousPort = ctx.env.config.port
                const previousRetentionDays = ctx.env.config.retentionDays
                const previousDb = ctx.env.config.dbPath
                applyConfig(ctx.env.config, config)

                if (config.port !== previousPort) {
                    console.log(`config port changed ${previousPort} -> ${config.port}; restart for the new port to take effect`)
                }
                if (config.dbPath !== previousDb) {
                    console.log(`config db changed ${previousDb ?? '(disabled)'} -> ${config.dbPath ?? '(disabled)'}; restart for the new db to take effect`)
                }
                if (config.retentionDays !== previousRetentionDays) {
                    console.log(`config retentionDays changed ${previousRetentionDays} -> ${config.retentionDays}; restart for the new retention policy to take effect`)
                }

                res.writeHead(200, {
                    'content-type': 'application/json',
                })
                res.end(JSON.stringify(stripConfigApiKey(config), undefined, 2))
            })
            ctx.req.on('error', (err: Error) => {
                if (!res.headersSent) respondError(res, 400, 'client_error', `Failed to read request: ${err.message}`)
            })
        },
    )),
)
