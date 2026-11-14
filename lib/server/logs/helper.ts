import * as http from 'http'
import * as https from 'https'
import type {OutgoingHttpHeaders, ServerResponse} from 'http'
import {respondError, router, type RequestContext, type RequestHandler, type Route} from '../../router'
import {resolveTarget, type UpstreamTracker} from '../helper'
import {isRemoteDb, parseRemoteDb, type ModelAlias, type RemoteUsageDb, type RuntimeConfig} from '../../config'
import {applyAlias, recordUsage, type UsageEntry} from './db'

export interface UsageCounts {
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
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

export const MAX_BODY = 1024 * 1024

/** Best-effort log side effect: recording must never break the proxied request
 *  or escape an event handler as an uncaught exception. */
export function safeLog (action: string, fn: () => void): void {
    try {
        fn()
    } catch (err) {
        console.error(`Failed to ${action}:`, err)
    }
}

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

export function applySSEFrame (usage: UsageCounts, line: string): void {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') return
    try {
        applyUsageObject(usage, JSON.parse(payload) as Record<string, unknown>)
    } catch {
        // Ignore non-JSON SSE frames (comments, keep-alives, chunk boundaries).
    }
}

export function feedStreamUsage (state: {carry: string}, usage: UsageCounts, chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    state.carry += text
    let newlineIdx: number
    while ((newlineIdx = state.carry.indexOf('\n')) !== -1) {
        const line = state.carry.slice(0, newlineIdx)
        state.carry = state.carry.slice(newlineIdx + 1)
        applySSEFrame(usage, line)
    }
    if (state.carry.length > MAX_STREAM_CARRY) {
        // Keep only the tail; usage frames arrive near the end of the stream.
        state.carry = state.carry.slice(-MAX_STREAM_CARRY)
    }
}

export const USAGE_REQUEST_TIMEOUT_MS = 30_000

/** Record one usage row: in-process into the storage this instance owns, or
 *  through the usage API when the db is remote. Aliasing happens here, so the
 *  row a remote owner receives is already canonical and stored verbatim.
 *  `upstream` tracks the posting request when storage is remote, so shutdown
 *  drains a row that is still on its way to the owner. */
export function recordUsageEntry (entry: UsageEntry, config: RuntimeConfig, upstream?: UpstreamTracker): void {
    if (config.dbPath === undefined) return // no store to record to
    const row = withAliasedModel(entry, config.alias)
    const remote = parseRemoteDb(config.dbPath)
    if (remote === undefined) {
        recordUsage(row)
        return
    }
    postUsageEntry(row, remote, upstream)
}

function withAliasedModel (entry: UsageEntry, alias: ModelAlias): UsageEntry {
    return {...entry, model: applyAlias(alias, entry.provider, entry.model)}
}

/** Send one already-aliased row to a remote usage API. Fire-and-forget: a
 *  failure logs and drops the row, exactly like a failed local insert always did. */
function postUsageEntry (entry: UsageEntry, {url, key}: RemoteUsageDb, upstream?: UpstreamTracker): void {
    const body = JSON.stringify(entry)
    const target = resolveTarget(url, '/logs')
    const request = target.isHttps ? https.request : http.request

    const req = request({
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'authorization': `Bearer ${key}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body).toString(),
        },
    }, (res) => {
        res.resume()
        if ((res.statusCode ?? 0) >= 300) {
            console.error(`usage row ${entry.requestId} rejected by ${target.origin}: HTTP ${res.statusCode}`)
        }
    })

    let settled = false
    const untrack = upstream?.track(() => req.destroy(new Error('aborted before the owner answered')))
    const settle = (): void => {
        if (settled) return
        settled = true
        untrack?.()
    }

    req.on('close', settle)
    req.setTimeout(USAGE_REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`usage API ${target.origin} timed out after ${USAGE_REQUEST_TIMEOUT_MS}ms`))
    })
    req.on('error', (e: Error) => {
        settle()
        console.error(`usage row ${entry.requestId} not stored (${target.origin}): ${e.message}`)
    })
    req.end(body)
}

export function forwardToRemoteDb (handler: RequestHandler | Route[]): Route[] {
    return router(
        ({env}) => isRemoteDb(env.config.dbPath),
        forwardUsageRequest,
        handler,
    )
}

function forwardUsageRequest (ctx: RequestContext, res: ServerResponse): void {
    const remote = parseRemoteDb(ctx.env.config.dbPath)
    if (remote === undefined) {
        return respondError(res, 500, 'server_error', 'No remote usage db configured')
    }

    const target = resolveTarget(remote.url, ctx.req.url ?? '/')
    const request = target.isHttps ? https.request : http.request

    const headers: Record<string, string> = {
        accept: 'application/json',
        authorization: `Bearer ${remote.key}`,
    }
    const contentType = ctx.req.headers['content-type']
    if (typeof contentType === 'string') headers['content-type'] = contentType
    const contentLength = ctx.req.headers['content-length']
    if (typeof contentLength === 'string') headers['content-length'] = contentLength

    const upstreamReq = request({
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method: ctx.req.method ?? 'GET',
        headers,
    }, (upstreamRes) => {
        const responseHeaders: Record<string, string> = {'cache-control': 'no-cache'}
        const upstreamContentType = upstreamRes.headers['content-type']
        if (typeof upstreamContentType === 'string') responseHeaders['content-type'] = upstreamContentType
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
        upstreamRes.on('error', () => res.destroy())
        upstreamRes.on('close', () => {
            if (!upstreamRes.complete) res.destroy()
        })
        upstreamRes.pipe(res)
    })

    upstreamReq.setTimeout(USAGE_REQUEST_TIMEOUT_MS, () => {
        upstreamReq.destroy(new Error(`usage API ${target.origin} timed out after ${USAGE_REQUEST_TIMEOUT_MS}ms`))
    })
    let clientDropped = false
    upstreamReq.on('error', (e: Error) => {
        if (clientDropped) return
        if (res.headersSent) {
            // the relay already started: ending here would fake a clean EOF
            res.destroy()
            return
        }
        respondError(res, 502, 'upstream_error', `Usage API unreachable: ${e.message}`)
    })
    ctx.req.on('error', () => upstreamReq.destroy())
    res.on('close', () => {
        if (!res.writableEnded) clientDropped = true
        upstreamReq.destroy()
    })

    ctx.req.pipe(upstreamReq)
}

export function parseUsageEntry (raw: string): UsageEntry {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error('Invalid JSON in the usage entry')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('The usage entry must be a JSON object')
    }
    const record = parsed as Record<string, unknown>

    const requestId = optionalString(record.requestId)
    if (requestId === undefined) throw new Error('"requestId" must be a non-empty string')
    const time = optionalNumber(record.time)
    if (time === undefined) throw new Error('"time" must be a number')
    const method = optionalString(record.method)
    if (method === undefined) throw new Error('"method" must be a non-empty string')
    const path = optionalString(record.path)
    if (path === undefined) throw new Error('"path" must be a non-empty string')

    return {
        requestId,
        time,
        method,
        path,
        provider: optionalString(record.provider),
        model: optionalString(record.model),
        status: optionalNumber(record.status),
        durationMs: optionalNumber(record.durationMs),
        ttftMs: optionalNumber(record.ttftMs),
        generationMs: optionalNumber(record.generationMs),
        inputTokens: optionalNumber(record.inputTokens),
        outputTokens: optionalNumber(record.outputTokens),
        cachedTokens: optionalNumber(record.cachedTokens),
        requestBody: optionalBody(record.requestBody),
        responseBody: optionalBody(record.responseBody),
    }

    function optionalString (value: unknown): string | undefined {
        return typeof value === 'string' && value.length > 0 ? value : undefined
    }

    function optionalNumber (value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    }

    function optionalBody (value: unknown): string | undefined {
        if (typeof value !== 'string' || value.length === 0) return undefined
        return value.slice(0, MAX_BODY)
    }
}
