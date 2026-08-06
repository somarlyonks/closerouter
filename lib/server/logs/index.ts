import type {IncomingMessage, OutgoingHttpHeaders, ServerResponse} from 'http'
import {randomUUID} from 'crypto'
import {router, needsCookie, withMethod, MAX_BODY, type RequestContext} from '../../util'
import {indexHTML} from './index.html'

export interface LogEntry {
    id: string
    phase: 'request' | 'response'
    time: string
    method: string
    path: string
    status?: number
    durationMs?: number
    requestBody?: string
    requestHeaders?: IncomingMessage['headers']
    responseBody?: string
    responseHeaders?: OutgoingHttpHeaders
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
    (_ctx, res) => {
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
        })
        res.end(indexHTML)
    },
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
        publishLog({
            id,
            phase: 'response',
            time: new Date().toISOString(),
            method: req.method!,
            path: req.url!,
            status: responseLog?.status ?? (res.headersSent ? res.statusCode : undefined),
            durationMs: Date.now() - startedAt,
            responseBody: responseLog?.body,
            responseHeaders: responseLog?.headers,
        })
    })
}
