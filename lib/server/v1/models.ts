import {ServerResponse} from 'http'
import type {RequestContext} from '../../router'
import type {UpstreamTracker} from '../helper'
import type {ProviderConfig} from '../../config'
import {proxyGetRequest} from '../../proxy'

/** How long a single provider may take to list its models before /v1/models
 *  gives up and serves that provider's configured models instead. Deliberately
 *  far below the 180s generation idle timeout: /v1/models is a quick metadata
 *  call clients block on (e.g. pi model discovery at startup). */
export const MODEL_LIST_TIMEOUT_MS = 5000

export function normalizeModel (provider: string, model: unknown): unknown {
    if (typeof model === 'string') return {id: `${provider}/${model}`}

    if (typeof model !== 'object' || !model || !(model as Record<string, unknown>).id) throw new Error('Model config broken')
    const props = JSON.parse(JSON.stringify(model))
    props.id = `${provider}/${props.id}`
    props.owned_by = props.owned_by || provider
    return props
}

export function listModelsHandler (
    idleTimeoutMs: number = MODEL_LIST_TIMEOUT_MS,
): (ctx: RequestContext, res: ServerResponse) => Promise<void> {
    return async (ctx, res) => {
        const cache = ctx.env.modelsCache
        const fetchModels = (): Promise<unknown[]> => fetchAllModels(ctx.env.config.providers, ctx.env.upstream, idleTimeoutMs)

        if (cache !== undefined) {
            const cached = cache.get()
            if (cached !== undefined) {
                sendModelList(res, cached)
                if (cache.isStale()) {
                    void cache.refresh(fetchModels).catch((err) => {
                        console.error('Background model list refresh failed:', err instanceof Error ? err.message : err)
                    })
                }
                return
            }
            sendModelList(res, await cache.refresh(fetchModels))
            return
        }

        sendModelList(res, await fetchModels())
    }
}

async function fetchAllModels (providers: Record<string, ProviderConfig>, upstream?: UpstreamTracker, idleTimeoutMs: number = MODEL_LIST_TIMEOUT_MS): Promise<unknown[]> {
    const modelsByProvider = await Promise.all(Object.entries(providers).map(async ([name, provider]) => {
        let models: unknown[]
        try {
            models = (await fetchProviderModels(provider.base_url, provider.api_key, upstream, idleTimeoutMs))
        } catch (err) {
            console.error(
                `Failed to fetch models from provider "${name}", using config models instead:`,
                err instanceof Error ? err.message : err,
            )
            models = provider.models || []
        }
        return {name, models}
    }))

    const data: unknown[] = []
    for (const {name, models} of modelsByProvider) {
        for (const model of models) data.push(normalizeModel(name, model))
    }
    return data
}

function sendModelList (res: ServerResponse, data: unknown[]): void {
    res.writeHead(200, {
        'content-type': 'application/json',
    })
    const payload: unknown = {object: 'list', data}
    res.end(JSON.stringify(payload, undefined, 2))
}

async function fetchProviderModels (baseUrl: string, apiKey: string, upstream?: UpstreamTracker, idleTimeoutMs: number = MODEL_LIST_TIMEOUT_MS): Promise<unknown[]> {
    const {statusCode, body} = await proxyGetRequest(baseUrl, apiKey, '/models', upstream, idleTimeoutMs)
    if (statusCode !== 200) throw new Error(`Provider returned status ${statusCode}`)

    let parsed: unknown
    try {
        parsed = JSON.parse(body)
    } catch {
        throw new Error('Failed to parse provider response')
    }

    const data = (parsed as Record<string, unknown> | null)?.data
    if (!Array.isArray(data)) {
        throw new Error('Unexpected provider response (expected {"data": [...]})')
    }

    return data
        .filter(m => typeof m === 'object')
        .filter(m => typeof (m as Record<string, unknown>)?.id === 'string')
}
