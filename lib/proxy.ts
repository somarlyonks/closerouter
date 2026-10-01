import * as http from 'http'
import * as https from 'https'
import {ClientRequest, IncomingMessage, ServerResponse} from 'http'
import {appendResponseBody, feedStreamUsage, logResponse, safeLog} from './server/logs/helper'
import type {ResponseLog, UsageCounts} from './server/logs/helper'
import {errorBody, readRequestBody, respondError, type RequestContext} from './router'
import type {UpstreamTracker} from './server/helper'
import type {ProviderConfig} from './config'

// Headers that are hop-by-hop (RFC 7230 §6.1) or owned by the proxy itself are
// never relayed in either direction. Content-Length and Authorization are
// replaced, Host is derived by Node from the target URL, and Transfer-Encoding
// is re-negotiated by Node's client/server stacks.
const HOP_BY_HOP = [
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]

// Client → provider: only headers that carry client intent are relayed. An
// allowlist keeps inbound proxy metadata (Tailscale Serve, X-Forwarded-*,
// cookies) off the third-party connection and leaves every header the proxy
// owns (Content-Type, Content-Length, Authorization, Accept-Encoding, Host) to
// be set or omitted explicitly.
const REQUEST_ALLOW = new Set([
    'accept',
    'user-agent',
    'openai-beta',
    'x-request-id',
    'x-client-request-id',
])

// Provider → client: everything else on the response is relayed verbatim.
// The proxy's own CORS headers are applied centrally (server/helper.ts), so
// provider-sent CORS is stripped to avoid duplicate, conflicting values.
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

type RelayHeaders = Record<string, string | string[] | undefined>

type RelayRule = (name: string) => boolean

function relayHeaders (source: RelayHeaders, isRelayed: RelayRule): Record<string, string> {
    const connectionHeaders = new Set<string>()
    const connection = source.connection
    // The Connection header names extra hop-by-hop headers (RFC 7230 §6.1);
    // normalize its string | string[] | undefined shape before reading it.
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
        if (value === undefined || !isRelayed(name.toLowerCase()) || connectionHeaders.has(name.toLowerCase())) continue
        if (Array.isArray(value)) {
            headers[name] = value.join(', ')
        } else {
            headers[name] = value
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

interface Target {
    isHttps: boolean
    hostname: string
    port: number
    urlPath: string
}

function resolveTarget (baseUrl: string, path: string): Target {
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    const targetUrl = new URL(normalizedBaseUrl + path)
    const isHttps = targetUrl.protocol === 'https:'

    return {
        isHttps,
        hostname: getHostname(targetUrl),
        port: getPort(targetUrl, isHttps),
        urlPath: targetUrl.pathname + targetUrl.search,
    }

    function getPort (targetUrl: URL, isHttps: boolean): number {
        if (targetUrl.port !== '') return Number(targetUrl.port)
        return isHttps ? 443 : 80
    }

    // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), but
    // http.request's hostname option wants the bare address.
    function getHostname (targetUrl: URL): string {
        const hostname = targetUrl.hostname
        if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1)
        return hostname
    }
}

interface ClientState {
    readonly res: ServerResponse
    ended: boolean
    closed: boolean
}

function createClientState (res: ServerResponse): ClientState {
    const state: ClientState = {res, ended: false, closed: false}
    res.on('close', () => {
        state.closed = true
    })
    return state
}

function clientWritable (client: ClientState): boolean {
    return !client.closed && !client.ended
}

function safeWriteHead (client: ClientState, statusCode: number, headers: Record<string, string>): void {
    if (!clientWritable(client)) return
    try {
        client.res.writeHead(statusCode, headers)
    } catch (err) {
        console.error('Failed to write client response headers:', err)
    }
}

function safeWrite (client: ClientState, chunk: Buffer): void {
    if (!clientWritable(client)) return
    try {
        client.res.write(chunk)
    } catch (err) {
        console.error('Failed to write client response chunk:', err)
    }
}

function safeEnd (client: ClientState, body?: string): void {
    if (!clientWritable(client)) return
    client.ended = true
    try {
        if (body === undefined) client.res.end()
        else client.res.end(body)
    } catch (err) {
        console.error('Failed to end client response:', err)
    }
}

function forwardResponse (backendRes: IncomingMessage, client: ClientState, responseLog: ResponseLog | undefined, settleUpstream: () => void): void {
    const statusCode = backendRes.statusCode ?? 500
    const headers = relayHeaders(backendRes.headers, name => !RESPONSE_STRIP.has(name))

    safeWriteHead(client, statusCode, headers)
    safeLog('record response headers', () => logResponse(responseLog, {status: statusCode, headers}))

    safeLog('initialize response usage', () => {
        if (responseLog && !responseLog.usage) responseLog.usage = {}
    })
    const usage: UsageCounts | undefined = responseLog?.usage
    const usageState = {carry: ''}

    let firstChunkAt: number | undefined
    backendRes.on('data', (chunk: Buffer) => {
        safeLog('record response chunk', () => {
            if (firstChunkAt === undefined) {
                firstChunkAt = Date.now()
                if (responseLog) responseLog.firstTokenAt = firstChunkAt
            }
            if (usage) feedStreamUsage(usageState, usage, chunk)
            appendResponseBody(responseLog, chunk)
        })
        safeWrite(client, chunk)
    })
    backendRes.on('end', () => {
        safeLog('record response completion', () => {
            if (responseLog && firstChunkAt !== undefined) responseLog.lastTokenAt = Date.now()
        })
        safeEnd(client)
    })
    backendRes.on('error', () => {
        safeEnd(client)
    })
    // 'close' always fires - including for an aborted stream that emits neither
    // 'end' nor 'error' - so settling here can never leak a tracked upstream
    // request. Settling is idempotent, so 'end'/'error' need not repeat it.
    backendRes.on('close', settleUpstream)
}

function handleBackendError (err: Error, client: ClientState, responseLog: ResponseLog | undefined): void {
    console.error('Backend request error:', err)
    const body = errorBody({
        type: 'proxy_error',
        message: `Backend request failed: ${err.message}`,
    })
    if (!client.res.headersSent) {
        safeWriteHead(client, 502, {'content-type': 'application/json'})
        safeLog('record backend error', () => logResponse(responseLog, {status: 502, headers: {'content-type': 'application/json'}, body}))
    } else {
        safeLog('record backend error body', () => appendResponseBody(responseLog, body))
    }
    safeEnd(client, body)
}

export function proxyRequest (
    ctx: RequestContext,
    clientRes: ServerResponse,
    baseUrl: string,
    apiKey: string,
    path: string,
    rewriteBody?: (body: string) => string,
): void {
    const clientReq = ctx.req
    const responseLog = ctx.responseLog
    const upstream = ctx.env.upstream
    const {isHttps, hostname, port, urlPath} = resolveTarget(baseUrl, path)
    const method = clientReq.method || 'POST'
    const client = createClientState(clientRes)

    function sendToBackend (body: string) {
        if (rewriteBody) {
            body = rewriteBody(body)
        }

        const contentLength = Buffer.byteLength(body).toString()
        // Owned headers are set with lowercase names so they can never coexist
        // with a relayed peer that differs only by case: the scriptc runtime
        // does not dedupe header names the way Node's http client does, and a
        // duplicated Content-Type makes strict gateways reject the body.
        const headers = relayHeaders(clientReq.headers, name => REQUEST_ALLOW.has(name))
        headers['content-type'] = 'application/json'
        headers['authorization'] = `Bearer ${apiKey}`
        headers['content-length'] = contentLength
        const backendReq = backendRequest(isHttps, hostname, port, urlPath, method, headers)
        const tracked = upstream !== undefined
            ? upstream.track(() => backendReq.destroy())
            : undefined
        const settleUpstream = (): void => {
            if (tracked !== undefined) tracked()
        }
        backendReq.on('response', (backendRes) => {
            forwardResponse(backendRes, client, responseLog, settleUpstream)
        })

        // A dropped client socket must not keep pulling from the backend:
        // cancel the upstream request whether or not the backend has answered
        // yet.
        let clientDropped = false
        const dropBackend = (): void => {
            clientDropped = true
            backendReq.destroy()
        }
        backendReq.on('error', (err: Error) => {
            settleUpstream()
            // Destroying the request after a client drop can surface the torn
            // -down socket as ECONNRESET; that is expected, not a backend
            // failure, so it must not be logged or answered as a 502.
            if (clientDropped) return
            handleBackendError(err, client, responseLog)
        })
        // 'close' fires after the response completes and on a destroy that
        // emits no 'error', so settling here keeps a tracked request from
        // leaking even when the error path is skipped.
        backendReq.on('close', settleUpstream)
        clientRes.on('close', () => {
            if (!client.ended) dropBackend()
        })

        backendReq.write(body)
        backendReq.end()
    }

    readRequestBody(ctx).then(sendToBackend)
    clientReq.on('error', (err: Error) => {
        console.error('Client request error:', err)
        if (!client.res.headersSent) {
            const body = errorBody({
                type: 'client_error',
                message: `Bad request: ${err.message}`,
            })
            safeWriteHead(client, 400, {'content-type': 'application/json'})
            safeLog('record client error', () => logResponse(responseLog, {status: 400, headers: {'content-type': 'application/json'}, body}))
            safeEnd(client, body)
        }
    })
}

export function proxyGetRequest (
    baseUrl: string,
    apiKey: string,
    path: string,
    upstream?: UpstreamTracker,
): Promise<{statusCode: number, body: string}> {
    const {isHttps, hostname, port, urlPath} = resolveTarget(baseUrl, path)

    return new Promise((resolve, reject) => {
        const req = backendRequest(
            isHttps, hostname, port, urlPath, 'GET',
            {Authorization: `Bearer ${apiKey}`},
        )
        const tracked = upstream !== undefined
            ? upstream.track(() => req.destroy())
            : undefined
        const chunks: Buffer[] = []
        let settled = false
        // One settle path for every end: resolving twice is harmless, but a
        // single guard keeps the tracker release exactly-once whatever order
        // 'end', 'error' and 'close' arrive in.
        const settle = (err: Error | undefined, statusCode?: number): void => {
            if (settled) return
            settled = true
            if (tracked !== undefined) tracked()
            if (err !== undefined) reject(err)
            else resolve({statusCode: statusCode ?? 500, body: Buffer.concat(chunks).toString('utf-8')})
        }
        req.on('response', (res) => {
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => settle(undefined, res.statusCode ?? 500))
            res.on('error', (err: Error) => settle(err))
            // A response aborted mid-body can emit 'close' without 'end' or
            // 'error'; failing the pending promise there keeps model-list
            // fetches from hanging shutdown.
            res.on('close', () => settle(new Error('upstream response closed before completion')))
        })
        req.on('error', (err: Error) => settle(err))
        req.end()
    })
}

export function proxyModelRequest (
    ctx: RequestContext,
    res: ServerResponse,
    endpoint: string,
): void {
    readRequestBody(ctx).then((bodyStr) => {
        let model: string | undefined
        try {
            const body = JSON.parse(bodyStr)
            model = body.model
        } catch {
            respondError(res, 400, 'invalid_request_error', 'Invalid JSON in request body')
            return
        }

        if (!model) {
            respondError(res, 400, 'invalid_request_error', 'Missing "model" field in request body')
            return
        }

        const slashIdx = model.indexOf('/')
        const providerName = model.slice(0, slashIdx)
        const realModel = model.slice(slashIdx + 1)
        if (slashIdx <= 0 || !providerName || !realModel) {
            respondError(res, 404, 'model_not_found', `Model "${model}" is unavailable`)
            return
        }

        if (!(providerName in ctx.env.config.providers)) {
            respondError(res, 404, 'model_not_found', `Provider "${providerName}" is not configured`)
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

        proxyRequest(ctx, res, provider.base_url, provider.api_key, endpoint, rewriteBody)
    })

    ctx.req.on('error', (err) => {
        console.error('Error reading request body:', err)
        if (!res.headersSent) respondError(res, 400, 'client_error', `Failed to read request: ${err.message}`)
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
