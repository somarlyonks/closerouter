import type {IncomingMessage, OutgoingHttpHeaders, ServerResponse} from 'http'
import {randomUUID} from 'crypto'
import {router, needsCookie, withMethod, MAX_BODY, handleHTML, type RequestContext} from '../../util'
import {recordUsage} from './db'
import {indexHTML} from './index.html'

export interface LogEntry {
    id: string
    phase: 'request' | 'response'
    time: string
    method: string
    path: string
    status?: number
    durationMs?: number
    ttftMs?: number
    generationMs?: number
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    requestBody?: string
    requestHeaders?: IncomingMessage['headers']
    responseBody?: string
    responseHeaders?: OutgoingHttpHeaders
}

interface TokenUsage {
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
}

type LogListener = (entry: LogEntry) => void

const listeners: LogListener[] = []

export function publishLog (entry: LogEntry): void {
    for (const listener of listeners) listener(entry)
}

export const handleLogs = withMethod('GET')(router(
    r => r.req.headers['accept'] === 'text/event-stream',
    needsCookie((_ctx, res) => {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            'connection': 'keep-alive',
            'access-control-allow-origin': '*',
            'x-accel-buffering': 'no',
        })

        const listener: LogListener = (entry) => {
            res.write('event: log\n')
            res.write(`data: ${JSON.stringify(entry)}\n\n`)
        }
        listeners.push(listener)

        const heartbeat = setInterval(() => res.write('event: ping\n\n'), 3000)
        heartbeat.unref()

        res.on('close', () => {
            clearInterval(heartbeat)
            listeners.splice(listeners.indexOf(listener), 1)
        })
    }),
    handleHTML(indexHTML),
))

export function logMiddleware ({req, responseLog}: RequestContext, res: ServerResponse) {
    if (req.url === '/logs') return

    const id = randomUUID()
    const startedAt = Date.now()
    const bodyChunks: Buffer[] = []
    let bodyBytes = 0
    req.on('data', (chunk: Buffer) => {
        if (bodyBytes < MAX_BODY) {
            bodyChunks.push(chunk)
            bodyBytes += chunk.length
        }
    })

    let logged = false
    const logRequest = () => {
        if (logged) return
        logged = true
        publishLog({
            id,
            phase: 'request',
            time: new Date().toISOString(),
            method: req.method!,
            path: req.url!,
            requestBody: bodyChunks.length > 0 ? Buffer.concat(bodyChunks).toString('utf-8').slice(0, MAX_BODY) : undefined,
            requestHeaders: req.headers,
        })
    }
    req.on('end', logRequest)
    res.on('close', () => {
        logRequest()
        const usage = extractTokenUsage(responseLog?.body)
        const firstTokenAt = responseLog?.firstTokenAt
        const lastTokenAt = responseLog?.lastTokenAt
        publishLog({
            id,
            phase: 'response',
            time: new Date().toISOString(),
            method: req.method!,
            path: req.url!,
            status: responseLog?.status ?? (res.headersSent ? res.statusCode : undefined),
            durationMs: Date.now() - startedAt,
            ttftMs: firstTokenAt !== undefined ? firstTokenAt - startedAt : undefined,
            generationMs: firstTokenAt !== undefined && lastTokenAt !== undefined ? lastTokenAt - firstTokenAt : undefined,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens,
            responseBody: responseLog?.body,
            responseHeaders: responseLog?.headers,
        })
        if (responseLog?.provider !== undefined && responseLog.model !== undefined) {
            recordUsage({
                ts: startedAt,
                method: req.method!,
                path: req.url!,
                provider: responseLog.provider,
                model: responseLog.model,
                status: responseLog.status ?? (res.headersSent ? res.statusCode : undefined),
                durationMs: Date.now() - startedAt,
                ttftMs: firstTokenAt !== undefined ? firstTokenAt - startedAt : undefined,
                generationMs: firstTokenAt !== undefined && lastTokenAt !== undefined ? lastTokenAt - firstTokenAt : undefined,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cachedTokens: usage.cachedTokens,
            })
        }
    })
}

function extractTokenUsage (body: string | undefined): TokenUsage {
    const result: TokenUsage = {}
    if (!body) return result

    const apply = (usage: unknown) => {
        if (!usage || typeof usage !== 'object') return
        const u = usage as Record<string, unknown>
        if (typeof u.prompt_tokens === 'number') result.inputTokens = u.prompt_tokens
        if (typeof u.completion_tokens === 'number') result.outputTokens = u.completion_tokens
        const details = u.prompt_tokens_details as Record<string, unknown> | undefined
        if (details && typeof details.cached_tokens === 'number') result.cachedTokens = details.cached_tokens
    }

    try {
        apply((JSON.parse(body) as Record<string, unknown>).usage)
    } catch {
        // Not a single JSON document — fall through to SSE parsing below.
    }

    if (result.inputTokens === undefined || result.outputTokens === undefined) {
        for (const line of body.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
                apply((JSON.parse(payload) as Record<string, unknown>).usage)
            } catch {
                // Ignore non-JSON SSE frames.
            }
        }
    }

    return result
}
