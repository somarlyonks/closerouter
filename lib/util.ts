import type {IncomingMessage, ServerResponse, OutgoingHttpHeaders} from 'http'
import type {Config} from './config'

type Env = {
    host: string
    config: Config
    apiKey: string
}

export interface ResponseLog {
    status?: number
    headers?: OutgoingHttpHeaders
    body?: string
    chunkCount?: number
}

export interface RequestContext {
    req: IncomingMessage
    env: Env
    responseLog?: ResponseLog
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
        ctx => ctx.req.headers.authorization === `Bearer ${ctx.env.apiKey}`,
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

export function needsCookie (handler: RequestHandler) {
    return router(
        ctx => cookieValue(ctx.req, 'cr-key') === ctx.env.apiKey,
        handler,
        (_ctx, res) => {
            res.writeHead(401, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: 'Invalid or missing API key. Use the cr-key cookie',
                    type: 'authentication_error',
                },
            }))
        },
    )

    function cookieValue (req: IncomingMessage, name: string): string | undefined {
        const c = req.headers.cookie
        if (typeof c !== 'string') return undefined
        for (const part of c.split(';')) {
            const p = part.trim()
            if (p.startsWith(name + '=')) return p.slice(name.length + 1)
        }
        return undefined
    }
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

const MAX_CHUNKS = 4
const MAX_BODY = 4096

export function logResponse (log: ResponseLog | undefined, update: ResponseLog): void {
    if (!log) return
    if (update.status !== undefined) log.status = update.status
    if (update.headers !== undefined) log.headers = update.headers
    if (update.body !== undefined) log.body = update.body
}

export function appendResponseBody (log: ResponseLog | undefined, chunk: string | Buffer): void {
    if (!log) return
    if ((log.chunkCount ?? 0) >= MAX_CHUNKS) return
    log.chunkCount = (log.chunkCount ?? 0) + 1
    log.body = (log.body ?? '') + (typeof chunk === 'string' ? chunk : chunk.toString('utf-8'))
    if (log.body.length > MAX_BODY) log.body = log.body.slice(0, MAX_BODY)
}
