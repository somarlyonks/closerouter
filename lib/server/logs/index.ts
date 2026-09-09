import type {IncomingMessage, ServerResponse} from 'http'
import {randomUUID} from 'crypto'
import {router, needsAuth, withMethod, MAX_BODY, handleHTML, applyUsageObject, type RequestContext} from '../../util'
import {recordUsage, loadUsage, loadUsageBody} from './db'
import {indexHTML} from './index.html'

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

export const handleLogs = withMethod('GET')(router(
    r => r.req.url === '/logs',
    router(
        r => r.req.headers['accept'] === 'application/json',
        needsAuth((_ctx, res) => {
            res.writeHead(200, {
                'content-type': 'application/json',
                'cache-control': 'no-cache',
                'access-control-allow-origin': '*',
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
                'access-control-allow-origin': '*',
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

    res.on('close', () => {
        if (responseLog?.provider === undefined || responseLog.model === undefined) return
        const usage = hasUsage(responseLog?.usage)
            ? responseLog!.usage!
            : extractTokenUsage(responseLog?.body)
        const firstTokenAt = responseLog?.firstTokenAt
        const lastTokenAt = responseLog?.lastTokenAt

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

export function extractTokenUsage (body: string | undefined): TokenUsage {
    const result: TokenUsage = {}
    if (!body) return result

    try {
        applyUsageObject(result, JSON.parse(body) as Record<string, unknown>)
    } catch {
        // Not a single JSON document - fall through to SSE line parsing below.
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
