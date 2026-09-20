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

export interface RoutePredicate {
    (ctx: RequestContext): boolean
}

/** A predicate plus the metadata it carries: the method the route requires
 *  and the static url pattern it matches. The method lets the dispatcher
 *  aggregate one 405 allow header across sibling routes instead of the first
 *  method route eagerly rejecting the request. */
export interface RouteHead {
    predicate: RoutePredicate
    method?: string
    pattern?: string
}

export interface Route {
    predicate: RoutePredicate
    handler: RequestHandler | Route[]
    method?: string
    pattern?: string
    /** a plain-handler continuation wrapped as a catch-all; yields to method
     *  mismatches recorded during the scan, since a matching resource makes
     *  405 more precise than the fallback's 404/401 */
    fallback?: boolean
}

function isRoutes (h: RequestHandler | Route[]): h is Route[] {
    return Array.isArray(h)
}

export function router (
    predicate: RoutePredicate | RouteHead,
    handler: RequestHandler | Route[],
    cont: RequestHandler | Route[] = handleNotFound,
): Route[] {
    const head: RouteHead = typeof predicate === 'function' ? {predicate} : predicate
    const tail: Route[] = isRoutes(cont) ? cont : [{predicate: () => true, handler: cont, fallback: true}]
    return [{predicate: head.predicate, method: head.method, pattern: head.pattern, handler}, ...tail]
}

/** Execute a router composition as a request handler. */
export function handle (routes: Route[]): RequestHandler {
    return (ctx, res) => {
        const allowed: string[] = []
        if (!dispatch(routes, ctx, res, allowed)) answer(ctx, res, allowed)
    }

    /** Depth-first scan in registration order. A route whose predicate fails
     *  but whose declared method differs from the request's is recorded and
     *  the scan continues, so a later sibling can still match (e.g. a POST
     *  route living after a GET route for the same path) and unmatched
     *  siblings contribute their method to the aggregated allow header.
     *  A matched route owns its subtree: when nothing inside handled the
     *  request it answers from the methods recorded there instead of falling
     *  through to outer siblings, so e.g. a POST to a GET-only path never
     *  reaches a sibling that proxies POSTs for other paths. Each descent
     *  starts with a fresh record, so mismatches recorded outside a matched
     *  route never suppress a fallback inside it. */
    function dispatch (routes: Route[], ctx: RequestContext, res: ServerResponse, allowed: string[]): boolean {
        for (const route of routes) {
            if (route.predicate(ctx)) {
                if (route.fallback && allowed.length > 0) continue
                const handler = route.handler
                if (isRoutes(handler)) {
                    const nested: string[] = []
                    if (dispatch(handler, ctx, res, nested)) return true
                    answer(ctx, res, nested)
                    return true
                }
                handler(ctx, res)
                return true
            }
            if (route.method !== undefined && ctx.req.method !== route.method && !allowed.includes(route.method)) {
                allowed.push(route.method)
            }
        }
        return false
    }

    /** Answer an exhausted scan from the methods it recorded: 405 when the path
     *  exists but rejects the request's method, else 404. */
    function answer (ctx: RequestContext, res: ServerResponse, allowed: string[]): void {
        if (allowed.length > 0) handleMethodNotAllowed(ctx, res, allowed.join(', '))
        else handleNotFound(ctx, res)
    }
}

/** Path predicate carrying its pattern, matched against the request pathname
 *  with the query string ignored. The pattern's suffix picks the match kind:
 *
 *  - `/status`    exact pathname equality
 *  - `/v1/*`      raw pathname prefix: matches `/v1/models` and even
 *                 `/v1/chat/completions`, but not bare `/v1`
 *  - `/logs@*`    the path itself plus everything below it: matches `/logs`
 *                 and `/logs/1`, but not `/logsfoo`
 */
export function path (pattern: string): RouteHead {
    return {predicate: matchPath(pattern), pattern}

    function matchPath (pattern: string): RoutePredicate {
        if (pattern.endsWith('@*')) {
            const base = pattern.slice(0, -2)
            return ({req}) => {
                const p = pathname(req.url)
                return p === base || p?.startsWith(base + '/') === true
            }
        }
        if (pattern.endsWith('*')) {
            const base = pattern.slice(0, -1)
            return ({req}) => pathname(req.url)?.startsWith(base) === true
        }
        return ({req}) => pathname(req.url) === pattern
    }

    function pathname (url: string | undefined): string | undefined {
        if (url === undefined) return undefined
        return new URL('http://localhost' + url).pathname
    }
}

/** Method predicate; the carried method lets the dispatcher aggregate 405s. */
export function method (m: string): RouteHead {
    return {predicate: ({req}) => req.method === m, method: m}
}

export function withMethod (m: string) {
    return (handler: RequestHandler | Route[]): Route[] => {
        const head = method(m)
        return [{predicate: head.predicate, method: m, handler}]
    }
}

export function needsAuth (handler: RequestHandler | Route[]) {
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

function handleMethodNotAllowed ({req}: RequestContext, res: ServerResponse, allow: string): void {
    res.writeHead(405, {'content-type': 'application/json', 'allow': allow})
    res.end(JSON.stringify({
        error: {
            message: `Method not allowed: ${req.method} ${req.url}`,
            type: 'method_not_allowed',
        },
    }))
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
