import {parseConfig, applyConfig, type RuntimeConfig, type ProviderConfig} from '../../config'
import {router, handleHTML, needsAuth, withMethod, handleBadRequest} from '../../util'
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
    const providerEntries: [string, Record<string, unknown>][] = []
    for (const [name, provider] of Object.entries(config.providers)) {
        providerEntries.push([name, {
            base_url: provider.base_url,
            models: provider.models || [],
        }])
    }
    const providers: Record<string, Record<string, unknown>> = Object.fromEntries(providerEntries)

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

    const mergedProviderEntries: [string, unknown][] = []
    for (const [name, provider] of Object.entries(obj.providers as Record<string, unknown>)) {
        if (typeof provider !== 'object' || !provider) continue
        const p = provider as Record<string, unknown>
        const copy: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(p)) copy[k] = v
        const typed = p.api_key
        if ((typed === undefined || typed === '') && Object.keys(stored).includes(name)) {
            copy.api_key = stored[name].api_key
        }
        mergedProviderEntries.push([name, copy])
    }

    const merged: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) merged[k] = v
    merged.providers = Object.fromEntries(mergedProviderEntries)
    return JSON.stringify(merged)
}

export const handleConfig = router(
    c => c.req.method === 'GET',
    router(
        c => !!c.req.headers['accept']?.includes('application/json'),
        needsAuth((ctx, res) => {
            res.writeHead(200, {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
            })
            res.end(JSON.stringify(stripConfigApiKey(ctx.env.config), undefined, 2))
        }),
        handleHTML(indexHTML),
    ),
    withMethod('PUT')(needsAuth(
        (ctx, res) => {
            const chunks: Buffer[] = []
            ctx.req.on('data', (chunk: Buffer) => chunks.push(chunk))
            ctx.req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8')

                let config
                try {
                    config = parseConfig(mergeProviderSecrets(raw, ctx.env.config.providers))
                } catch (e) {
                    return handleBadRequest(res, e instanceof Error ? e.message : 'Invalid config')
                }

                const previousPort = ctx.env.config.port
                const previousRetentionDays = ctx.env.config.retentionDays
                applyConfig(ctx.env.config, config)

                if (previousPort !== undefined && config.port !== previousPort) {
                    console.log(
                        `config port changed ${previousPort} -> ${config.port}; restart for the new port to take effect`,
                    )
                }
                if (config.retentionDays !== previousRetentionDays) {
                    console.log(
                        `config retentionDays changed ${previousRetentionDays} -> ${config.retentionDays}; restart for the new retention policy to take effect`,
                    )
                }

                res.writeHead(200, {
                    'content-type': 'application/json',
                    'access-control-allow-origin': '*',
                })
                res.end(JSON.stringify(stripConfigApiKey(config), undefined, 2))
            })
            ctx.req.on('error', (err: Error) => {
                if (!res.headersSent) {
                    res.writeHead(400, {'content-type': 'application/json'})
                    res.end(JSON.stringify({
                        error: {
                            message: `Failed to read request: ${err.message}`,
                            type: 'client_error',
                        },
                    }))
                }
            })
        },
    )),
)
