import * as http from 'http'
import * as https from 'https'
import {ClientRequest, IncomingMessage, ServerResponse} from 'http'
import {appendResponseBody, feedStreamUsage, logResponse} from './util'
import type {ResponseLog, RequestContext, UsageCounts} from './util'

function getPort (targetUrl: URL, isHttps: boolean): number {
    const host = targetUrl.host
    const colonIdx = host.indexOf(':')
    if (colonIdx !== -1) {
        return parseInt(host.slice(colonIdx + 1), 10)
    }
    return isHttps ? 443 : 80
}

function firstHeader (val: string | string[] | undefined): string | undefined {
    if (val === undefined) return undefined
    return Array.isArray(val) ? val[0] : val
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
        'access-control-allow-origin': '*',
    }
    const ct = firstHeader(backendRes.headers['content-type'])
    if (ct) headers['content-type'] = ct

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
        const backendReq = backendRequest(
            isHttps, hostname, port, urlPath, method,
            {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': contentLength,
            },
        )
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
