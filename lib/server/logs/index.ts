import type {IncomingMessage, OutgoingHttpHeaders, ServerResponse} from 'http'
import {randomUUID} from 'crypto'
import {router, needsCookie, withMethod, MAX_BODY, handleHTML, applyUsageObject, type RequestContext} from '../../util'
import {recordUsage, loadUsage, loadUsageBody} from './db'
import {indexHTML} from './index.html'

export interface LogGroup {
    id: string
    phase: 'request' | 'response'
    time: number
    method: string
    path: string
    provider?: string
    model?: string
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

function hasUsage (usage: TokenUsage | undefined): boolean {
    return usage !== undefined && (
        usage.inputTokens !== undefined
        || usage.outputTokens !== undefined
        || usage.cachedTokens !== undefined
    )
}

type LogListener = (entry: LogGroup) => void

const listeners: LogListener[] = []

export function publishLog (entry: LogGroup): void {
    for (const listener of listeners) listener(entry)
}

export const handleLogs = withMethod('GET')(router(
    r => !!logDetailId(r.req.url),
    needsCookie((ctx, res) => {
        const body = loadUsageBody(logDetailId(ctx.req.url)!)
        res.writeHead(body ? 200 : 404, {
            'content-type': 'application/json',
            'cache-control': 'no-cache',
            'access-control-allow-origin': '*',
        })
        res.end(JSON.stringify(body ?? {error: {message: 'usage entry not found', type: 'not_found'}}))
    }),
    router(
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
        router(
            r => r.req.headers['accept'] === 'application/json',
            needsCookie((_ctx, res) => {
                res.writeHead(200, {
                    'content-type': 'application/json',
                    'cache-control': 'no-cache',
                    'access-control-allow-origin': '*',
                })
                res.end(JSON.stringify({entries: loadUsage()}))
            }),
            handleHTML(indexHTML),
        ),
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

export function logMiddleware ({req, responseLog}: RequestContext, res: ServerResponse) {
    if (!req.url?.startsWith('/v1/')) return

    const id = readClientRequestId(req) ?? randomUUID()
    res.setHeader('x-closerouter-request-id', id)
    const startedAt = Date.now()
    const bodyChunks: Buffer[] = []
    let bodyBytes = 0
    req.on('data', (chunk: Buffer) => {
        if (bodyBytes < MAX_BODY) {
            bodyChunks.push(chunk)
            bodyBytes += chunk.length
        }
    })

    const readRequestBody = () => bodyChunks.length > 0 ? Buffer.concat(bodyChunks).toString('utf-8').slice(0, MAX_BODY) : undefined

    let logged = false
    const logRequest = () => {
        if (logged) return
        logged = true
        publishLog({
            id,
            phase: 'request',
            time: Date.now(),
            method: req.method!,
            path: req.url!,
            requestBody: readRequestBody(),
            requestHeaders: req.headers,
        })
    }
    req.on('end', logRequest)
    res.on('close', () => {
        logRequest()
        const usage = hasUsage(responseLog?.usage)
            ? responseLog!.usage!
            : extractTokenUsage(responseLog?.body)
        const firstTokenAt = responseLog?.firstTokenAt
        const lastTokenAt = responseLog?.lastTokenAt

        publishLog({
            id,
            phase: 'response',
            time: Date.now(),
            method: req.method!,
            path: req.url!,
            provider: responseLog?.provider,
            model: responseLog?.model,
            status: responseLog?.status ?? (res.headersSent ? res.statusCode : undefined),
            durationMs: Date.now() - startedAt,
            ttftMs: firstTokenAt !== undefined ? firstTokenAt - startedAt : undefined,
            generationMs: firstTokenAt !== undefined && lastTokenAt !== undefined ? lastTokenAt - firstTokenAt : undefined,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedTokens,
            requestBody: readRequestBody(),
            requestHeaders: req.headers,
            responseBody: responseLog?.body,
            responseHeaders: responseLog?.headers,
        })
        if (responseLog?.provider !== undefined && responseLog.model !== undefined) {
            recordUsage({
                requestId: id,
                time: startedAt,
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
                requestBody: readRequestBody(),
                responseBody: responseLog.body,
            })
        }
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

function extractTokenUsage (body: string | undefined): TokenUsage {
    const result: TokenUsage = {}
    if (!body) return result

    try {
        applyUsageObject(result, JSON.parse(body) as Record<string, unknown>)
    } catch {
        // Not a single JSON document — fall through to SSE line parsing below.
    }

    if (result.inputTokens === undefined || result.outputTokens === undefined) {
        for (const line of body.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
                applyUsageObject(result, JSON.parse(payload) as Record<string, unknown>)
            } catch {
                // Ignore non-JSON SSE frames.
            }
        }
    }

    return result
}
