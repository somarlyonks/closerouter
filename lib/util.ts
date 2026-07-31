import type {IncomingMessage, ServerResponse} from 'http'
import type {Config, ModelEntry, ModelConfig} from './config'

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

function handleNotFound ({req: {method, url}}: RequestContext, res: ServerResponse) {
    res.writeHead(404, {'content-type': 'application/json'})
    res.end(JSON.stringify({
        error: {
            message: `Not found: ${method} ${url}`,
            type: 'not_found',
        },
    }))
}
