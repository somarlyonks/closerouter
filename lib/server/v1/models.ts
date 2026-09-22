import {ServerResponse} from 'http'
import type {RequestContext} from '../../router'
import {proxyGetRequest} from '../../proxy'

export function normalizeModel (provider: string, model: unknown): unknown {
    if (typeof model === 'string') return {id: `${provider}/${model}`}

    if (typeof model !== 'object' || !model || !(model as Record<string, unknown>).id) throw new Error('Model config broken')
    const props = JSON.parse(JSON.stringify(model))
    props.id = `${provider}/${props.id}`
    props.owned_by = props.owned_by || provider
    return props
}

export async function handleListModels (
    ctx: RequestContext,
    res: ServerResponse,
): Promise<void> {
    const {providers} = ctx.env.config

    const modelsByProvider = await Promise.all(Object.entries(providers).map(async ([name, provider]) => {
        let models: unknown[]
        try {
            models = (await fetchProviderModels(provider.base_url, provider.api_key))
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

    res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
    })
    const payload: unknown = {object: 'list', data}
    res.end(JSON.stringify(payload, undefined, 2))
}

async function fetchProviderModels (baseUrl: string, apiKey: string): Promise<unknown[]> {
    const {statusCode, body} = await proxyGetRequest(baseUrl, apiKey, '/models')
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
