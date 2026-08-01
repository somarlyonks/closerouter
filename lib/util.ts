import type {IncomingMessage, ServerResponse} from 'http'
import type {Config} from './config'

type Env = {
    host: string
    config: Config
    apiKey: string
}

export interface RequestContext {
    req: IncomingMessage
    env: Env
}

export type RequestHandler = (ctx: RequestContext, res: ServerResponse) => void

type RoutePredicate = (ctx: RequestContext) => boolean

export function router (
    predicate: RoutePredicate,
    handler: RequestHandler,
    cont: RequestHandler = handleNotFound,
): RequestHandler {
    return (ctx, res) => (predicate(ctx) ? handler : cont)(ctx, res)
}

export function needsAuth (handler: RequestHandler) {
    return router(
        ctx => !!ctx.req.headers.authorization && ctx.req.headers.authorization === `Bearer ${ctx.env.apiKey}`,
        handler,
        (_ctx, res) => {
            res.writeHead(401, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: 'Invalid or missing API key. Use Authorization: Bearer <key>',
                    type: 'authentication_error',
                },
            }))
        },
    )
}

function handleNotFound ({req}: RequestContext, res: ServerResponse) {
    res.writeHead(404, {'content-type': 'application/json'})
    res.end(JSON.stringify({
        error: {
            message: `Not found: ${req.method} ${req.url}`,
            type: 'not_found',
        },
    }))
}

export function normalizeModel (provider: string, model: unknown): unknown {
    if (typeof model === 'string') return {id: `${provider}/${model}`}

    if (typeof model !== 'object' || !model || !(model as Record<string, unknown>).id) throw new Error('Model config broken')
    const props = JSON.parse(JSON.stringify(model))
    props.id = `${provider}/${typeof model === 'string' ? model : props.id}`
    props.owned_by = props.owned_by || provider
    return props
}
