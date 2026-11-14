import type {IncomingMessage, ServerResponse} from 'http'
import {randomUUIDv7} from 'crypto'
import {router, needsAuth, withMethod, path, handleHTML, handleBadRequest, readRequestBody, respondError, type RequestContext} from '../../router'
import {MAX_BODY, applySSEFrame, applyUsageObject, forwardToRemoteDb, parseUsageEntry, recordUsageEntry, safeLog} from './helper'
import type {UsageCounts} from './helper'
import {loadUsage, loadUsageBody, recordUsage, type UsageEntry, type UsageLogQuery} from './db'
import {html as indexHTML} from './index.html'

const MAX_USAGE_ENTRY_BYTES = 8 * 1024 * 1024

function hasUsage (usage: UsageCounts | undefined): boolean {
    return usage !== undefined && (
        usage.inputTokens !== undefined
        || usage.outputTokens !== undefined
        || usage.cachedTokens !== undefined
    )
}

export const handleLogs = router(
    path('/logs'),
    [
        ...withMethod('GET')(router(
            r => r.req.headers['accept'] === 'application/json',
            needsAuth(forwardToRemoteDb(listUsage)),
            handleHTML(indexHTML),
        )),
        ...withMethod('POST')(needsAuth(forwardToRemoteDb(appendUsage))),
    ],
    withMethod('GET')(needsAuth(forwardToRemoteDb(showUsageBody))),
)

function listUsage (ctx: RequestContext, res: ServerResponse): void {
    const query = parseLogSearchParams(new URL('http://localhost' + (ctx.req.url ?? '/')))
    sendJSON(res, 200, loadUsage(query))
}

function showUsageBody (ctx: RequestContext, res: ServerResponse): void {
    const id = logDetailId(ctx.req.url)
    if (id === undefined) return respondError(res, 404, 'not_found', 'usage entry not found')
    const body = loadUsageBody(id)
    if (body === undefined) return respondError(res, 404, 'not_found', 'usage entry not found')
    sendJSON(res, 200, body)
}

/** Write endpoint of the usage API: an instance posts the row it recorded here
 *  and the db owner stores it verbatim - the recording instance already applied
 *  its own alias map. */
async function appendUsage (ctx: RequestContext, res: ServerResponse): Promise<void> {
    if (declaredLength(ctx.req) > MAX_USAGE_ENTRY_BYTES) return rejectOversizedEntry(ctx.req, res)

    const raw = await readBoundedBody(ctx.req, MAX_USAGE_ENTRY_BYTES)
    if (raw === undefined) return rejectOversizedEntry(ctx.req, res)

    let entry: UsageEntry
    try {
        entry = parseUsageEntry(raw)
    } catch (e) {
        return handleBadRequest(res, e instanceof Error ? e.message : 'Invalid usage entry')
    }

    if (!recordUsage(entry)) {
        return respondError(res, 503, 'storage_unavailable', 'Usage storage is not available on this instance')
    }
    sendJSON(res, 201, {ok: true})
}

function declaredLength (req: IncomingMessage): number {
    const declared = Number(req.headers['content-length'])
    return Number.isFinite(declared) ? declared : 0
}

function rejectOversizedEntry (req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('connection', 'close')
    respondError(res, 413, 'payload_too_large', `Usage entry exceeds ${MAX_USAGE_ENTRY_BYTES} bytes`)
    res.once('finish', () => req.destroy())
}

function readBoundedBody (req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        let settled = false

        function finish (value: string | undefined): void {
            if (settled) return
            settled = true
            resolve(value)
        }

        req.on('data', (chunk: Buffer) => {
            if (settled) return
            size += chunk.length
            if (size > maxBytes) {
                chunks.length = 0
                req.pause()
                return finish(undefined)
            }
            chunks.push(chunk)
        })
        req.on('end', () => finish(Buffer.concat(chunks).toString('utf-8')))
        req.on('error', (e: Error) => {
            if (settled) return
            settled = true
            reject(e)
        })
    })
}

function sendJSON (res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-cache',
    })
    res.end(JSON.stringify(payload))
}

function parseLogSearchParams (url: URL): UsageLogQuery {
    const num = (name: string): number | undefined => {
        const v = url.searchParams.get(name)
        return v !== null && /^\d+$/.test(v) ? Number(v) : undefined
    }

    return {
        limit: num('limit'),
        offset: num('offset'),
        search: url.searchParams.get('q') ?? undefined,
    }
}

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
    const {req, responseLog, env} = ctx

    const id = readClientRequestId(req) ?? randomUUIDv7()
    res.setHeader('x-closerouter-request-id', id)
    const startedAt = Date.now()
    const bodyText = readRequestBody(ctx)

    res.on('close', () => {
        if (responseLog?.provider === undefined || responseLog.model === undefined) return
        const {provider, model} = responseLog
        const usage = hasUsage(responseLog.usage) ? responseLog.usage! : extractTokenUsage(responseLog.body)
        const firstTokenAt = responseLog.firstTokenAt
        const lastTokenAt = responseLog.lastTokenAt

        bodyText.then(raw => safeLog('record usage', () => recordUsageEntry({
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
        }, env.config, env.upstream)))
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
