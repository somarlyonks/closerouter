import type {IncomingMessage, ServerResponse, OutgoingHttpHeaders} from 'http'
import type {RuntimeConfig} from './config'

type Env = {
    config: RuntimeConfig
}

export interface ResponseLog {
    status?: number
    headers?: OutgoingHttpHeaders
    body?: string
    firstTokenAt?: number
    lastTokenAt?: number
    provider?: string
    model?: string
    usage?: UsageCounts
}

export interface UsageCounts {
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
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

export function withMethod (method: string) {
    return (handler: RequestHandler) => router(
        ctx => ctx.req.method !== method,
        ({req}, res) => {
            res.writeHead(405, {'content-type': 'application/json', 'allow': method})
            res.end(JSON.stringify({
                error: {
                    message: `Method not allowed: ${req.method} ${req.url}`,
                    type: 'method_not_allowed',
                },
            }))
        },
        handler,
    )
}

export function needsAuth (handler: RequestHandler) {
    return router(
        ctx => ctx.req.headers.authorization === `Bearer ${ctx.env.config.key}`,
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
        ctx => cookieValue(ctx.req, 'cr-key') === ctx.env.config.key,
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

function handleNotFound ({req}: RequestContext, res: ServerResponse): void {
    res.writeHead(404, {'content-type': 'application/json'})
    res.end(JSON.stringify({
        error: {
            message: `Not found: ${req.method} ${req.url}`,
            type: 'not_found',
        },
    }))
}

export function handleBadRequest (res: ServerResponse, message: string): void {
    res.writeHead(400, {'content-type': 'application/json'})
    res.end(JSON.stringify({
        error: {
            message,
            type: 'invalid_request_error',
        },
    }))
}

export function handleHTML (html: string): RequestHandler {
    return (_ctx, res) => {
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
        })
        res.end(html)
    }
}

export function normalizeModel (provider: string, model: unknown): unknown {
    if (typeof model === 'string') return {id: `${provider}/${model}`}

    if (typeof model !== 'object' || !model || !(model as Record<string, unknown>).id) throw new Error('Model config broken')
    const props = JSON.parse(JSON.stringify(model))
    props.id = `${provider}/${props.id}`
    props.owned_by = props.owned_by || provider
    return props
}

export const MAX_BODY = 1024 * 1024

export function logResponse (log: ResponseLog | undefined, update: ResponseLog): void {
    if (!log) return
    if (update.status !== undefined) log.status = update.status
    if (update.headers !== undefined) log.headers = update.headers
    if (update.body !== undefined) log.body = update.body
}

export function appendResponseBody (log: ResponseLog | undefined, chunk: string | Buffer): void {
    if (!log) return
    if ((log.body?.length ?? 0) >= MAX_BODY) return
    log.body = (log.body ?? '') + (typeof chunk === 'string' ? chunk : chunk.toString('utf-8'))
    if (log.body.length > MAX_BODY) log.body = log.body.slice(0, MAX_BODY)
}

const MAX_STREAM_CARRY = 1024 * 1024

export function applyUsageObject (usage: UsageCounts, obj: Record<string, unknown>): void {
    const usageObj = obj.usage
    if (usageObj && typeof usageObj === 'object') readUsageObject(usage, usageObj as Record<string, unknown>)
    const response = obj.response
    if (response && typeof response === 'object') applyUsageObject(usage, response as Record<string, unknown>)

    function readUsageObject (usage: UsageCounts, u: Record<string, unknown>): void {
        // Chat Completions (non-stream + stream usage frame)
        if (typeof u.prompt_tokens === 'number') usage.inputTokens = u.prompt_tokens
        if (typeof u.completion_tokens === 'number') usage.outputTokens = u.completion_tokens
        const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined
        if (promptDetails && typeof promptDetails.cached_tokens === 'number') usage.cachedTokens = promptDetails.cached_tokens

        // Responses API: usage is measured in input/output tokens, cached nested under input_tokens_details
        if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens
        if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens
        const inputDetails = u.input_tokens_details as Record<string, unknown> | undefined
        if (inputDetails && typeof inputDetails.cached_tokens === 'number') usage.cachedTokens = inputDetails.cached_tokens
    }
}

export function feedStreamUsage (state: {carry: string}, usage: UsageCounts, chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    state.carry += text
    let newlineIdx: number
    while ((newlineIdx = state.carry.indexOf('\n')) !== -1) {
        const line = state.carry.slice(0, newlineIdx)
        state.carry = state.carry.slice(newlineIdx + 1)
        applyFrame(usage, line)
    }
    if (state.carry.length > MAX_STREAM_CARRY) {
        // Keep only the tail; usage frames arrive near the end of the stream.
        state.carry = state.carry.slice(-MAX_STREAM_CARRY)
    }

    function applyFrame (usage: UsageCounts, line: string): void {
        if (!line.startsWith('data:')) return
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') return
        try {
            applyUsageObject(usage, JSON.parse(payload) as Record<string, unknown>)
        } catch {
            // Ignore non-JSON SSE frames (comments, keep-alives, chunk boundaries).
        }
    }
}
