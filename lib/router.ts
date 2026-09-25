import type {IncomingMessage, ServerResponse} from 'http'
import type {RuntimeConfig} from './config'
import type {ResponseLog} from './server/logs/helper'

type Env = {
    config: RuntimeConfig
}

export interface RequestContext {
    req: IncomingMessage
    env: Env
    responseLog?: ResponseLog
}

/** A route handler. An async handler cannot be mounted directly - scriptc
 *  requires the exact void return - so adapt it with asyncHandler; the
 *  dispatcher still settles a slipped-through rejected promise at runtime. */
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

/** Compose routes: `predicate` guards `handler`, and `cont` runs when it does
 *  not - a nested router passes through, a plain handler becomes a
 *  catch-all. */
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
        const exhausted = scan(routes, ctx, res)
        if (exhausted !== undefined) answer(ctx, res, exhausted)
    }

    /** Depth-first scan in registration order; returns the methods its failed
     *  routes recorded when nothing handled the request, undefined when one
     *  did. A route whose predicate fails but whose declared method differs
     *  from the request's is recorded and the scan continues, so a later
     *  sibling can still match and unmatched siblings contribute their method
     *  to the aggregated allow header. A matched route owns its subtree:
     *  when nothing inside handled the request it answers from the methods
     *  recorded there instead of falling through to outer siblings, so e.g.
     *  a POST to a GET-only path never reaches a sibling that proxies POSTs
     *  for other paths. Each descent starts with a fresh record, so
     *  mismatches recorded outside a matched route never suppress a fallback
     *  inside it. */
    function scan (routes: Route[], ctx: RequestContext, res: ServerResponse): string[] | undefined {
        const allowed: string[] = []
        for (const route of routes) {
            if (!route.predicate(ctx)) {
                if (route.method !== undefined && ctx.req.method !== route.method && !allowed.includes(route.method)) {
                    allowed.push(route.method)
                }
                continue
            }
            if (route.fallback && allowed.length > 0) continue
            const handler = route.handler
            if (isRoutes(handler)) {
                const nested = scan(handler, ctx, res)
                if (nested !== undefined) answer(ctx, res, nested)
            } else {
                callHandler(handler, ctx, res)
            }
            return undefined
        }
        return allowed
    }
}

/** Answer an exhausted scan from the methods it recorded: 405 when the path
 *  exists but rejects the request's method, else 404. */
function answer (ctx: RequestContext, res: ServerResponse, allowed: string[]): void {
    if (allowed.length > 0) handleMethodNotAllowed(ctx, res, allowed.join(', '))
    else handleNotFound(ctx, res)
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

/** Gate a handler (or nested router) to one http method. */
export function withMethod (m: string) {
    return (handler: RequestHandler | Route[]): Route[] => router(method(m), handler)
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

/** Adapt an async handler for mounting: scriptc requires a route handler to
 *  return void, so the promise an async handler returns is answered here -
 *  its rejection would die as an unhandled rejection without this. */
export function asyncHandler (
    handler: (ctx: RequestContext, res: ServerResponse) => Promise<void>,
): RequestHandler {
    return (ctx, res) => {
        handler(ctx, res).catch((e: unknown) => handleServerError(res, e))
    }
}

/** Call a handler and answer the failure of a promise it should not have
 *  returned: nothing awaits it, so its rejection is answered here instead
 *  of dying as an unhandled rejection - a synchronous throw instead
 *  propagates to the caller's error boundary. */
function callHandler (handler: RequestHandler, ctx: RequestContext, res: ServerResponse): void {
    const result = handler(ctx, res) as void | Promise<void>
    if (typeof result === 'object' && result !== null) {
        result.catch((e: unknown) => handleServerError(res, e))
    }
}

/** Wrap a dispatch so a handler failure cannot kill the server or hang the
 *  client: a synchronous throw is caught here, while the rejected promise of
 *  an async handler is answered by callHandler - each failure reaches
 *  handleServerError exactly once. */
export function routerErrorBoundary (handler: RequestHandler): RequestHandler {
    return (ctx, res) => {
        try {
            callHandler(handler, ctx, res)
        } catch (e) {
            handleServerError(res, e)
        }
    }
}

export function handleServerError (res: ServerResponse, e: unknown): void {
    console.error(e)
    if (res.headersSent) {
        // the response already started: ending here would fake a clean EOF
        // after a partial body, so kill the transport instead - the client sees
        // a truncated response
        res.destroy()
        return
    }
    res.writeHead(500, {'content-type': 'application/json'})
    res.end(JSON.stringify({
        error: {
            message: 'Internal server error',
            type: 'server_error',
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
