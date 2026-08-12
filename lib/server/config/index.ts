import {parseConfig, applyConfig} from '../../config'
import {router, handleHTML, needsAuth, withMethod, handleBadRequest} from '../../util'
import {indexHTML} from './index.html'

interface VagueConfig {
    providers: Record<string, Record<string, unknown>>
}

export const handleConfig = router(
    c => c.req.method === 'GET',
    router(
        c => !!c.req.headers['accept']?.includes('application/json'),
        needsAuth((ctx, res) => {
            const {port, key, providers} = ctx.env.config

            const rawModelById = new Map<string, Record<string, unknown>>()
            try {
                const rawProviders = (JSON.parse(ctx.env.config.raw) as VagueConfig).providers
                for (const [name, provider] of Object.entries(rawProviders)) {
                    if (typeof provider !== 'object' || !provider || !provider.models || !Array.isArray(provider.models)) continue
                    const models = provider.models as unknown[]
                    for (const model of models) {
                        if (typeof model === 'object' && model) {
                            const m = model as Record<string, unknown>
                            if (typeof m.id === 'string') rawModelById.set(`${name}/${m.id}`, m)
                        }
                    }
                }
            } catch {
                // raw config unavailable; fall back to runtime models as-is
            }

            const enrichedProviders: Record<string, Record<string, unknown>> = {}
            for (const [name, provider] of Object.entries(providers)) {
                enrichedProviders[name] = {
                    base_url: provider.base_url,
                    api_key: provider.api_key,
                    models: (provider.models || []).map((model) => {
                        if (typeof model === 'string') return model
                        const id = typeof model === 'string' ? model : model.id
                        return rawModelById.get(`${name}/${id}`) || model
                    }),
                }
            }

            res.writeHead(200, {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
            })
            res.end(JSON.stringify({port, key, providers: enrichedProviders}, undefined, 2))
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
                    config = parseConfig(raw)
                } catch (e) {
                    return handleBadRequest(res, e instanceof Error ? e.message : 'Invalid config')
                }

                const previousPort = ctx.env.config.port
                applyConfig(ctx.env.config, config)

                if (previousPort !== undefined && config.port !== previousPort) {
                    console.log(
                        `config port changed ${previousPort} -> ${config.port}; restart for the new port to take effect`,
                    )
                }

                res.writeHead(200, {
                    'content-type': 'application/json',
                    'access-control-allow-origin': '*',
                })
                res.end(JSON.stringify(config, undefined, 2))
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
