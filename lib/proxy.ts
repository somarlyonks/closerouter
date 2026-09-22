import * as http from 'http'
import * as https from 'https'
import {ClientRequest, IncomingMessage, ServerResponse} from 'http'
import {appendResponseBody, feedStreamUsage, logResponse} from './server/logs/helper'
import type {ResponseLog, UsageCounts} from './server/logs/helper'
import type {RequestContext} from './router'
import type {ProviderConfig} from './config'

function getPort (targetUrl: URL, isHttps: boolean): number {
    const host = targetUrl.host
    const colonIdx = host.indexOf(':')
    if (colonIdx !== -1) {
        return parseInt(host.slice(colonIdx + 1), 10)
    }
    return isHttps ? 443 : 80
}

// Headers that are hop-by-hop (RFC 7230 §6.1) or owned by the proxy itself are
// never relayed in either direction. Content-Length and Authorization are
// replaced, Host is derived by Node from the target URL, and Transfer-Encoding
// is re-negotiated by Node's client/server stacks.
const HOP_BY_HOP = [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]

// Client → provider: everything else on the request is relayed verbatim.
const REQUEST_STRIP = new Set([
    ...HOP_BY_HOP,
    'host', // Node derives Host from the target URL
    'content-length', // recomputed from the forwarded (rewritten) body
    'authorization', // replaced with the provider key
    'expect', // 100-continue is already handled by Node's server before proxying
    'accept-encoding', // keep upstream responses uncompressed so usage/SSE parsing sees plaintext
    'cookie', // never leak client session cookies to a third-party provider
])

// Provider → client: everything else on the response is relayed verbatim.
const RESPONSE_STRIP = new Set([
    ...HOP_BY_HOP,
    'set-cookie', // don't let providers plant cookies on the caller
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'access-control-expose-headers',
    'access-control-allow-headers',
    'access-control-allow-methods',
    'access-control-max-age',
])

type RelayHeaders = Record<string, string | string[] | number | undefined>

function relayHeaders (source: RelayHeaders, strip: ReadonlySet<string>): Record<string, string> {
    const connectionHeaders = new Set<string>()
    const connection = source.connection
    // The Connection header names extra hop-by-hop headers (RFC 7230 §6.1).
    // Build a plain string[] - scriptc traps on array literals that could hold
    // undefined ( IncomingMessage.headers.connection is undefined when the
    // client sends none), so no `[connection]` shorthand.
    const connectionValues: string[] = Array.isArray(connection)
        ? connection
        : typeof connection === 'string' ? [connection] : []
    for (const value of connectionValues) {
        for (const name of value.split(',')) {
            connectionHeaders.add(name.trim().toLowerCase())
        }
    }

    const headers: Record<string, string> = {}
    for (const name in source) {
        const value = source[name]
        if (value === undefined || strip.has(name.toLowerCase()) || connectionHeaders.has(name.toLowerCase())) continue
        if (typeof value === 'string') {
            headers[name] = value
        } else if (typeof value === 'number') {
            headers[name] = String(value)
        } else {
            headers[name] = value.join(', ')
        }
    }
    return headers
}

function backendRequest (
    isHttps: boolean,
    hostname: string,
    port: number,
    path: string,
    method: string,
    headers: Record<string, string>,
): ClientRequest {
    if (isHttps) {
        return https.request({hostname, port, path, method, headers: headers})
    }
    return http.request({hostname, port, path, method, headers: headers})
}

function forwardResponse (backendRes: IncomingMessage, clientRes: ServerResponse, responseLog: ResponseLog | undefined): void {
    const statusCode = backendRes.statusCode ?? 500
    const headers: Record<string, string> = {
        ...relayHeaders(backendRes.headers, RESPONSE_STRIP),
        'access-control-allow-origin': '*',
        'access-control-expose-headers': '*',
    }

    logResponse(responseLog, {status: statusCode, headers})
    clientRes.writeHead(statusCode, headers)

    if (responseLog && !responseLog.usage) {
        responseLog.usage = {}
    }
    const usage: UsageCounts | undefined = responseLog?.usage
    const usageState = {carry: ''}

    let firstChunkAt: number | undefined
    backendRes.on('data', (chunk: Buffer) => {
        if (firstChunkAt === undefined) {
            firstChunkAt = Date.now()
            if (responseLog) responseLog.firstTokenAt = firstChunkAt
        }
        if (usage) feedStreamUsage(usageState, usage, chunk)
        appendResponseBody(responseLog, chunk)
        clientRes.write(chunk)
    })
    backendRes.on('end', () => {
        if (responseLog && firstChunkAt !== undefined) {
            responseLog.lastTokenAt = Date.now()
        }
        clientRes.end()
    })
    backendRes.on('error', () => {
        clientRes.end()
    })
}

function handleBackendError (err: Error, clientRes: ServerResponse, responseLog: ResponseLog | undefined): void {
    console.error('Backend request error:', err)
    const body = JSON.stringify({
        error: {
            message: `Backend request failed: ${err.message}`,
            type: 'proxy_error',
        },
    })
    if (!clientRes.headersSent) {
        logResponse(responseLog, {status: 502, headers: {'content-type': 'application/json'}, body})
        clientRes.writeHead(502, {'content-type': 'application/json'})
    } else {
        appendResponseBody(responseLog, body)
    }
    clientRes.end(body)
}

export function proxyRequest (
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    baseUrl: string,
    apiKey: string,
    path: string,
    rewriteBody?: (body: string) => string,
    preReadBody?: string,
    responseLog?: ResponseLog,
): void {
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    const targetUrl = new URL(normalizedBaseUrl + path)
    const isHttps = targetUrl.protocol === 'https:'
    const hostname = targetUrl.hostname
    const port = getPort(targetUrl, isHttps)
    const urlPath = targetUrl.pathname + targetUrl.search
    const method = clientReq.method || 'POST'

    function sendToBackend (body: string) {
        if (rewriteBody) {
            body = rewriteBody(body)
        }

        const contentLength = Buffer.byteLength(body).toString()
        const headers = relayHeaders(clientReq.headers, REQUEST_STRIP)
        headers['Content-Type'] = 'application/json'
        headers['Authorization'] = `Bearer ${apiKey}`
        headers['Content-Length'] = contentLength
        const backendReq = backendRequest(isHttps, hostname, port, urlPath, method, headers)
        backendReq.on('response', (backendRes) => {
            forwardResponse(backendRes, clientRes, responseLog)
        })
        backendReq.on('error', (err: Error) => handleBackendError(err, clientRes, responseLog))
        backendReq.write(body)
        backendReq.end()
    }

    if (preReadBody !== undefined) {
        sendToBackend(preReadBody)
    } else {
        const chunks: Buffer[] = []
        clientReq.on('data', (chunk: Buffer) => chunks.push(chunk))
        clientReq.on('end', () => {
            sendToBackend(Buffer.concat(chunks).toString('utf-8'))
        })
        clientReq.on('error', (err: Error) => {
            console.error('Client request error:', err)
            if (!clientRes.headersSent) {
                const body = JSON.stringify({
                    error: {
                        message: `Bad request: ${err.message}`,
                        type: 'client_error',
                    },
                })
                logResponse(responseLog, {status: 400, headers: {'content-type': 'application/json'}, body})
                clientRes.writeHead(400, {'content-type': 'application/json'})
                clientRes.end(body)
            }
        })
    }
}

export function proxyGetRequest (
    baseUrl: string,
    apiKey: string,
    path: string,
): Promise<{statusCode: number, body: string}> {
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    const targetUrl = new URL(normalizedBaseUrl + path)
    const isHttps = targetUrl.protocol === 'https:'
    const hostname = targetUrl.hostname
    const port = getPort(targetUrl, isHttps)
    const urlPath = targetUrl.pathname + targetUrl.search

    return new Promise((resolve, reject) => {
        const req = backendRequest(
            isHttps, hostname, port, urlPath, 'GET',
            {Authorization: `Bearer ${apiKey}`},
        )
        req.on('response', (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8')
                resolve({statusCode: res.statusCode ?? 500, body})
            })
            res.on('error', reject)
        })
        req.on('error', reject)
        req.end()
    })
}

export function proxyModelRequest (
    ctx: RequestContext,
    res: ServerResponse,
    endpoint: string,
): void {
    const chunks: Buffer[] = []
    const req = ctx.req
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf-8')

        let model: string | undefined
        try {
            const body = JSON.parse(bodyStr)
            model = body.model
        } catch {
            res.writeHead(400, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: 'Invalid JSON in request body',
                    type: 'invalid_request_error',
                },
            }))
            return
        }

        if (!model) {
            res.writeHead(400, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: 'Missing "model" field in request body',
                    type: 'invalid_request_error',
                },
            }))
            return
        }

        const slashIdx = model.indexOf('/')
        const providerName = model.slice(0, slashIdx)
        const realModel = model.slice(slashIdx + 1)
        if (slashIdx <= 0 || !providerName || !realModel) {
            res.writeHead(404, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: `Model "${model}" is unavailable`,
                    type: 'model_not_found',
                },
            }))
            return
        }

        if (!(providerName in ctx.env.config.providers)) {
            res.writeHead(404, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: `Provider "${providerName}" is not configured`,
                    type: 'model_not_found',
                },
            }))
            return
        }
        const provider = ctx.env.config.providers[providerName]
        if (ctx.responseLog) {
            ctx.responseLog.provider = providerName
            ctx.responseLog.model = realModel
        }

        const rewriteBody = (body: string): string => {
            try {
                const parsed = JSON.parse(body)
                parsed.model = realModel
                if (isGoogleProvider(provider)) return injectGoogleThoughtSignature(JSON.stringify(parsed))
                return JSON.stringify(parsed)
            } catch {
                return body
            }
        }

        proxyRequest(
            req,
            res,
            provider.base_url,
            provider.api_key,
            endpoint,
            rewriteBody,
            bodyStr,
            ctx.responseLog,
        )
    })

    req.on('error', (err) => {
        console.error('Error reading request body:', err)
        if (!res.headersSent) {
            res.writeHead(400, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: `Failed to read request: ${err.message}`,
                    type: 'client_error',
                },
            }))
        }
    })
}

export function isGoogleProvider ({base_url}: Pick<ProviderConfig, 'base_url'>): boolean {
    return base_url.includes('generativelanguage.googleapis.com')
        || base_url.includes('aiplatform.googleapis.com')
}

export function injectGoogleThoughtSignature (body: string): string {
    let parsed: Record<string, unknown>
    try {
        parsed = JSON.parse(body) as Record<string, unknown>
    } catch {
        return body
    }
    const sentinel = 'skip_thought_signature_validator'
    const messages = parsed.messages
    if (!Array.isArray(messages)) return body
    const msgs = messages as Array<Record<string, unknown>>
    const newMessages: Array<Record<string, unknown>> = []
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]
        if (typeof m !== 'object' || m === null) {
            newMessages.push(m)
            continue
        }
        if (m.role !== 'assistant') {
            newMessages.push(m)
            continue
        }
        const tcs = m.tool_calls
        if (!Array.isArray(tcs)) {
            newMessages.push(m)
            continue
        }
        const tcArr = tcs as Array<Record<string, unknown>>
        const newTcs: Array<Record<string, unknown>> = []
        for (let j = 0; j < tcArr.length; j++) {
            const t = tcArr[j]
            if (typeof t !== 'object' || t === null) {
                newTcs.push(t)
                continue
            }
            const g = (t.extra_content as Record<string, unknown> | undefined)?.google as Record<string, unknown> | undefined
            if (typeof g?.thought_signature === 'string') {
                newTcs.push(t)
                continue
            }
            newTcs.push({...t, extra_content: {google: {thought_signature: sentinel}}})
        }
        newMessages.push({...m, tool_calls: newTcs})
    }
    parsed.messages = newMessages
    return JSON.stringify(parsed)
}
