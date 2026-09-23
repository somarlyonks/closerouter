import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer, request, IncomingMessage, ServerResponse} from 'http'
import type {IncomingHttpHeaders} from 'http'
import type {AddressInfo} from 'net'
import {proxyRequest, proxyGetRequest} from '../lib/proxy'
import type {ResponseLog} from '../lib/server/logs/helper'
import {startMockBackend, delay} from './helpers'

interface FrontendOpts {
    baseUrl: string
    apiKey: string
    path?: string
    rewriteBody?: (body: string) => string
    preReadBody?: string
    responseLog?: ResponseLog
}

function startProxyFrontend (opts: FrontendOpts): Promise<{port: number, close: () => Promise<void>}> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        proxyRequest(req, res, opts.baseUrl, opts.apiKey, opts.path ?? '/x', opts.rewriteBody, opts.preReadBody, opts.responseLog)
    })
    return new Promise((resolve, reject) => {
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: (server.address() as AddressInfo).port,
                close: () => new Promise<void>(r => server.close(() => r())),
            })
        })
    })
}

interface RawRequestOptions {
    method?: string
    headers?: Record<string, string>
    body?: string
}

// Raw HTTP request so tests can inspect or set headers fetch() hides.
function rawRequest (
    port: number,
    path: string,
    options: RawRequestOptions = {},
): Promise<{statusCode: number | undefined, headers: IncomingHttpHeaders, body: string}> {
    return new Promise((resolve, reject) => {
        const req = request({
            hostname: '127.0.0.1',
            port,
            path,
            method: options.method,
            headers: options.headers,
        }, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf-8'),
            }))
        })
        req.on('error', reject)
        req.end(options.body)
    })
}

test('proxyGetRequest returns status code and body', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({data: [{id: 'a'}]}))
    })
    try {
        const {statusCode, body} = await proxyGetRequest(backend.baseUrl, 'k', '/models')
        assert.equal(statusCode, 200)
        assert.deepEqual(JSON.parse(body), {data: [{id: 'a'}]})
        assert.equal(backend.requests[0].headers.authorization, 'Bearer k')
        assert.equal(backend.requests[0].url, '/models')
        assert.equal(backend.requests[0].method, 'GET')
    } finally {
        await backend.close()
    }
})

test('proxyGetRequest surfaces non-200 responses', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(404)
        res.end('nope')
    })
    try {
        const {statusCode, body} = await proxyGetRequest(backend.baseUrl, 'k', '/models')
        assert.equal(statusCode, 404)
        assert.equal(body, 'nope')
    } finally {
        await backend.close()
    }
})

test('proxyGetRequest rejects when the backend is unreachable', async () => {
    await assert.rejects(
        proxyGetRequest('http://127.0.0.1:1', 'k', '/models'),
        /ECONNREFUSED|connect ECONNREFUSED/i,
    )
})

test('proxyRequest forwards status, content-type and CORS header', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/plain'})
        res.end('hello')
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/x'})
    try {
        const res = await fetch(`http://127.0.0.1:${frontend.port}/x`)
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'text/plain')
        assert.equal(res.headers.get('access-control-allow-origin'), '*')
        assert.equal(await res.text(), 'hello')
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest forwards POST method, body and auth header to backend', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200)
        res.end('ok')
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/chat'})
    try {
        const res = await fetch(`http://127.0.0.1:${frontend.port}/chat`, {
            method: 'POST',
            body: 'request-body',
            headers: {'content-type': 'application/json'},
        })
        assert.equal(res.status, 200)
        assert.equal(backend.requests[0].method, 'POST')
        assert.equal(backend.requests[0].body, 'request-body')
        assert.equal(backend.requests[0].url, '/chat')
        assert.equal(backend.requests[0].headers.authorization, 'Bearer k')
        assert.equal(backend.requests[0].headers['content-type'], 'application/json')
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest applies rewriteBody to the outgoing body', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200)
        res.end('ok')
    })
    const frontend = await startProxyFrontend({
        baseUrl: backend.baseUrl,
        apiKey: 'k',
        path: '/x',
        rewriteBody: b => b.toUpperCase(),
    })
    try {
        await fetch(`http://127.0.0.1:${frontend.port}/x`, {method: 'POST', body: 'abc'})
        assert.equal(backend.requests[0].body, 'ABC')
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest uses preReadBody instead of the client body', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200)
        res.end('ok')
    })
    const frontend = await startProxyFrontend({
        baseUrl: backend.baseUrl,
        apiKey: 'k',
        path: '/x',
        preReadBody: 'preset',
    })
    try {
        await fetch(`http://127.0.0.1:${frontend.port}/x`, {method: 'POST', body: 'ignored'})
        assert.equal(backend.requests[0].body, 'preset')
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest streams backend chunks to the client in order', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write('chunk1')
        setTimeout(() => {
            res.write('chunk2')
            res.end()
        }, 10)
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/x'})
    try {
        const res = await fetch(`http://127.0.0.1:${frontend.port}/x`)
        const text = await res.text()
        assert.equal(text, 'chunk1chunk2')
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest keeps streaming when a response log write throws', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write('chunk1')
        setTimeout(() => {
            res.write('chunk2')
            res.end()
        }, 10)
    })
    // Poison the body setter so every appendResponseBody() attempt throws.
    const responseLog: ResponseLog = {}
    Object.defineProperty(responseLog, 'body', {
        get: () => undefined,
        set: () => {
            throw new Error('log sink failed')
        },
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/x', responseLog})
    try {
        const res = await fetch(`http://127.0.0.1:${frontend.port}/x`)
        assert.equal(res.status, 200)
        assert.equal(await res.text(), 'chunk1chunk2')
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest keeps streaming when response usage initialization throws', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.end('complete')
    })
    const responseLog: ResponseLog = {}
    Object.defineProperty(responseLog, 'usage', {
        get: () => undefined,
        set: () => {
            throw new Error('usage sink failed')
        },
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/x', responseLog})
    try {
        const res = await fetch(`http://127.0.0.1:${frontend.port}/x`)
        assert.equal(res.status, 200)
        assert.equal(await res.text(), 'complete')
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest returns 502 when the backend is unreachable', async () => {
    const frontend = await startProxyFrontend({baseUrl: 'http://127.0.0.1:1', apiKey: 'k', path: '/x'})
    try {
        const res = await fetch(`http://127.0.0.1:${frontend.port}/x`, {method: 'POST', body: 'x'})
        assert.equal(res.status, 502)
        const json = await res.json() as {error: {type: string, message: string}}
        assert.equal(json.error.type, 'proxy_error')
        assert.match(json.error.message, /Backend request failed/)
    } finally {
        await frontend.close()
    }
})

test('proxyRequest closes the client response when the backend errors mid-stream', async () => {
    // Connect to a backend that accepts the request then errors after the first chunk.
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/plain'})
        res.write('partial')
        setImmediate(() => res.destroy(new Error('boom')))
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/x'})
    try {
        const res = await fetch(`http://127.0.0.1:${frontend.port}/x`, {method: 'POST', body: 'x'})
        const text = await res.text()
        assert.ok(text.startsWith('partial'))
    } finally {
        await frontend.close()
        await backend.close()
        await delay(0)
    }
})

test('proxyRequest cancels the backend when the client disconnects before response headers', async () => {
    let backendCompleted = false
    let backendCancelled = false
    let notifyBackendStarted: () => void = () => {}
    let notifyBackendClosed: () => void = () => {}
    const backendStarted = new Promise<void>((resolve) => {
        notifyBackendStarted = resolve
    })
    const backendClosed = new Promise<void>((resolve) => {
        notifyBackendClosed = resolve
    })
    const backend = await startMockBackend((_req, res) => {
        notifyBackendStarted()
        const timer = setTimeout(() => {
            backendCompleted = true
            res.end('late')
        }, 100)
        res.on('close', () => {
            clearTimeout(timer)
            backendCancelled = !res.writableEnded
            notifyBackendClosed()
        })
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/x'})
    try {
        const req = request({hostname: '127.0.0.1', port: frontend.port, path: '/x'})
        req.on('error', () => {})
        req.end()
        await backendStarted
        req.destroy()
        await Promise.race([backendClosed, delay(200)])
        assert.equal(backendCancelled, true)
        assert.equal(backendCompleted, false)
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest survives a client disconnect mid-stream', async () => {
    let backendWroteAfterDrop = false
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write('first')
        const timer = setTimeout(() => {
            if (!res.destroyed && !res.writableEnded) {
                backendWroteAfterDrop = true
                res.end('second')
            }
        }, 40)
        res.on('close', () => clearTimeout(timer))
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/x'})
    try {
        // Capture console.error to prove the intentional backend cancel is
        // not misreported as a backend failure.
        const errors: unknown[] = []
        const originalError = console.error
        console.error = (...args: unknown[]) => {
            errors.push(args[0])
        }
        try {
            // Destroy the client socket right after the first chunk arrives.
            await new Promise<void>((resolve) => {
                const req = request({hostname: '127.0.0.1', port: frontend.port, path: '/x'}, (res) => {
                    res.once('data', () => {
                        req.destroy()
                        resolve()
                    })
                })
                req.on('error', () => resolve())
                req.end()
            })
            // Let the backend's follow-up chunk either be dropped or written.
            await delay(80)
        } finally {
            console.error = originalError
        }
        assert.equal(errors.some((msg) => String(msg).startsWith('Backend request error:')), false)
        // The proxy must abandon the backend stream once the client is gone...
        assert.equal(backendWroteAfterDrop, false)
        // ...and the frontend must still be serving after the dropped connection.
        const res = await fetch(`http://127.0.0.1:${frontend.port}/x`)
        assert.equal(res.status, 200)
        assert.equal(await res.text(), 'firstsecond')
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest relays client request headers to the backend and replaces owned ones', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200)
        res.end('ok')
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/chat'})
    try {
        await fetch(`http://127.0.0.1:${frontend.port}/chat`, {
            method: 'POST',
            body: 'request-body',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'user-agent': 'pi/0.1 test-agent',
                'x-request-id': 'req-123',
                'accept': 'text/event-stream',
                'accept-encoding': 'gzip, deflate',
                'cookie': 'session=secret',
            },
        })
        const h = backend.requests[0].headers
        assert.equal(h['user-agent'], 'pi/0.1 test-agent')
        assert.equal(h['x-request-id'], 'req-123')
        assert.equal(h['accept'], 'text/event-stream')
        assert.equal(h.authorization, 'Bearer k')
        assert.equal(h['content-type'], 'application/json')
        assert.equal(h['content-length'], String(Buffer.byteLength('request-body')))
        assert.equal(h['accept-encoding'], undefined)
        assert.equal(h.cookie, undefined)
        // Host is derived from the target URL, not relayed from the client.
        assert.equal(h.host, new URL(backend.baseUrl).host)
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest removes headers nominated by Connection in both directions', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {
            'connection': 'x-response-hop',
            'x-response-hop': 'provider-secret',
        })
        res.end('ok')
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/x'})
    try {
        const {headers} = await rawRequest(frontend.port, '/x', {
            method: 'POST',
            headers: {
                'connection': 'close, x-request-hop',
                'x-request-hop': 'client-secret',
            },
            body: '{}',
        })
        assert.equal(backend.requests[0].headers['x-request-hop'], undefined)
        assert.equal(headers['x-response-hop'], undefined)
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest relays provider response headers to the client', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {
            'content-type': 'application/json',
            'x-request-id': 'prov-req-1',
            'x-ratelimit-limit-requests': '100',
            'retry-after': '30',
            'cache-control': 'no-store',
            'set-cookie': 'sid=abc; Path=/',
            'access-control-allow-origin': 'https://provider.example',
            'access-control-expose-headers': 'x-provider-only',
            'access-control-allow-credentials': 'true',
        })
        res.end('ok')
    })
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/x'})
    try {
        const {statusCode, headers, body} = await rawRequest(frontend.port, '/x')
        assert.equal(statusCode, 200)
        assert.equal(headers['x-request-id'], 'prov-req-1')
        assert.equal(headers['x-ratelimit-limit-requests'], '100')
        assert.equal(headers['retry-after'], '30')
        assert.equal(headers['cache-control'], 'no-store')
        assert.equal(headers['content-type'], 'application/json')
        assert.equal(headers['access-control-allow-origin'], '*')
        assert.equal(headers['access-control-expose-headers'], '*')
        assert.equal(headers['access-control-allow-credentials'], undefined)
        assert.equal(headers['set-cookie'], undefined)
        assert.equal(body, 'ok')
    } finally {
        await frontend.close()
        await backend.close()
    }
})
