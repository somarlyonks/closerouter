import * as http from 'http'
import * as https from 'https'
import {IncomingMessage, ServerResponse} from 'http'
import {appendResponseBody, logResponse, type ResponseLog} from './util'

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

function forwardResponse (backendRes: IncomingMessage, clientRes: ServerResponse, responseLog: ResponseLog | undefined): void {
    const statusCode = backendRes.statusCode ?? 500
    const headers: Record<string, string> = {
        'access-control-allow-origin': '*',
    }
    const ct = firstHeader(backendRes.headers['content-type'])
    if (ct) headers['content-type'] = ct

    logResponse(responseLog, {status: statusCode, headers})
    clientRes.writeHead(statusCode, headers)

    backendRes.on('data', (chunk: Buffer) => {
        appendResponseBody(responseLog, chunk)
        clientRes.write(chunk)
    })
    backendRes.on('end', () => {
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
        const request = isHttps ? https.request : http.request
        const backendReq = request({
            hostname, port, path: urlPath, method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': contentLength,
            },
        }, (backendRes) => {
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
        const request = isHttps ? https.request : http.request
        const req = request({
            hostname, port, path: urlPath, method: 'GET',
            headers: {Authorization: `Bearer ${apiKey}`},
        }, (res) => {
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
