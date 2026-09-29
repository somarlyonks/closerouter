import type {IncomingMessage, ServerResponse} from 'http'
import {randomUUID} from 'crypto'
import {router, needsAuth, withMethod, path, handleHTML, readRequestBody, type RequestContext} from '../../router'
import {MAX_BODY, applySSEFrame, applyUsageObject} from './helper'
import type {UsageCounts} from './helper'
import {recordUsage, loadUsage, loadUsageBody} from './db'
import {html as indexHTML} from './index.html'

function hasUsage (usage: UsageCounts | undefined): boolean {
    return usage !== undefined && (
        usage.inputTokens !== undefined
        || usage.outputTokens !== undefined
        || usage.cachedTokens !== undefined
    )
}

export const handleLogs = withMethod('GET')(router(
    path('/logs'),
    router(
        r => r.req.headers['accept'] === 'application/json',
        needsAuth((_ctx, res) => {
            res.writeHead(200, {
                'content-type': 'application/json',
                'cache-control': 'no-cache',
            })
            res.end(JSON.stringify({entries: loadUsage()}))
        }),
        handleHTML(indexHTML),
    ),
    router(
        r => !!logDetailId(r.req.url),
        needsAuth((ctx, res) => {
            const body = loadUsageBody(logDetailId(ctx.req.url)!)
            res.writeHead(body ? 200 : 404, {
                'content-type': 'application/json',
                'cache-control': 'no-cache',
            })
            res.end(JSON.stringify(body ?? {error: {message: 'usage entry not found', type: 'not_found'}}))
        }),
    ),
))

function logDetailId (url: string | undefined): number | undefined {
    if (!url) return undefined
    const path = url.split('?')[0]
    if (!path.startsWith('/logs/')) return undefined
    const rest = path.slice('/logs/'.length)
    if (!/^\d+$/.test(rest)) return undefined
    const id = Number(rest)
    return Number.isInteger(id) && id > 0 ? id : undefined
}

export function logMiddleware (ctx: RequestContext, res: ServerResponse) {
    if (!path('/v1/*').predicate(ctx)) return
    const {req, responseLog} = ctx

    const id = readClientRequestId(req) ?? randomUUID()
    res.setHeader('x-closerouter-request-id', id)
    const startedAt = Date.now()
    const bodyText = readRequestBody(ctx)

    res.on('close', () => {
        if (responseLog?.provider === undefined || responseLog.model === undefined) return
        const {provider, model} = responseLog
        const usage = hasUsage(responseLog.usage) ? responseLog.usage! : extractTokenUsage(responseLog.body)
        const firstTokenAt = responseLog.firstTokenAt
        const lastTokenAt = responseLog.lastTokenAt

        bodyText.then(raw => recordUsage({
            ...usage,
            requestId: id,
            time: startedAt,
            method: req.method!,
            path: req.url!,
            provider,
            model,
            status: responseLog.status ?? (res.headersSent ? res.statusCode : undefined),
            durationMs: Date.now() - startedAt,
            ttftMs: firstTokenAt !== undefined ? firstTokenAt - startedAt : undefined,
            generationMs: firstTokenAt !== undefined && lastTokenAt !== undefined ? lastTokenAt - firstTokenAt : undefined,
            requestBody: raw.length > 0 ? raw.slice(0, MAX_BODY) : undefined,
            responseBody: responseLog.body,
        }))
    })
}

function readClientRequestId (req: IncomingMessage): string | undefined {
    const header = req.headers['x-client-request-id'] || req.headers['x-request-id']
    const value = Array.isArray(header) ? header[0] : header
    if (typeof value !== 'string') return undefined
    const id = value.trim()
    if (id.length === 0 || id.length > 128 || id.includes('\r') || id.includes('\n')) return undefined
    return id
}

export function extractTokenUsage (body: string | undefined): UsageCounts {
    const result: UsageCounts = {}
    if (!body) return result

    try {
        applyUsageObject(result, JSON.parse(body) as Record<string, unknown>)
    } catch {
        // Not a single JSON document - fall through to SSE line parsing below.
    }

    if (result.inputTokens === undefined || result.outputTokens === undefined) {
        for (const line of body.split('\n')) applySSEFrame(result, line)
    }

    return result
}
