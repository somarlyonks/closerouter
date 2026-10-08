import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer, request, IncomingMessage, ServerResponse} from 'http'
import type {IncomingHttpHeaders} from 'http'
import type {AddressInfo} from 'net'
import {proxyRequest, proxyGetRequest} from '../lib/proxy'
import type {RequestContext} from '../lib/router'
import type {ResponseLog} from '../lib/server/logs/helper'
import {createUpstreamTracker, applyCors, type UpstreamTracker} from '../lib/server/helper'
import {startMockBackend, sampleConfig, delay} from './helpers'

interface FrontendOpts {
    baseUrl: string
    apiKey: string
    path?: string
    rewriteBody?: (body: string) => string
    responseLog?: ResponseLog
    upstream?: UpstreamTracker
    idleTimeoutMs?: number
}

function startProxyFrontend (opts: FrontendOpts): Promise<{port: number, close: () => Promise<void>}> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const ctx: RequestContext = {
            req,
            env: {config: sampleConfig(), upstream: opts.upstream},
            responseLog: opts.responseLog,
        }
        // applyCors mirrors lib/server/index so the pipeline under test carries
        // the same CORS headers production does.
        applyCors(res)
        proxyRequest(ctx, res, opts.baseUrl, opts.apiKey, opts.path ?? '/x', opts.rewriteBody, opts.idleTimeoutMs)
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

test('proxyRequest dials a bracketed IPv6 backend literal', async (t) => {
    let backend: Awaited<ReturnType<typeof startMockBackend>>
    try {
        backend = await startMockBackend((_req, res) => {
            res.writeHead(200, {'content-type': 'text/plain'})
            res.end('v6')
        }, '::1')
    } catch {
        t.skip('IPv6 loopback unavailable')
        return
    }
    const frontend = await startProxyFrontend({baseUrl: backend.baseUrl, apiKey: 'k', path: '/x'})
    try {
        const res = await fetch(`http://127.0.0.1:${frontend.port}/x`)
        assert.equal(res.status, 200)
        assert.equal(await res.text(), 'v6')
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

test('proxyRequest abort ends the downstream response so shutdown can drain', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        const timer = setInterval(() => res.write('data: {}\n\n'), 20)
        res.on('close', () => clearInterval(timer))
    })
    const upstream = createUpstreamTracker()
    const frontend = await startProxyFrontend({
        baseUrl: backend.baseUrl,
        apiKey: 'k',
        path: '/x',
        upstream,
    })
    try {
        const res = await new Promise<IncomingMessage>((resolve, reject) => {
            const req = request({hostname: '127.0.0.1', port: frontend.port, path: '/x', method: 'POST'}, resolve)
            req.on('error', reject)
            req.end('{}')
        })
        await new Promise<void>(resolve => res.once('data', () => resolve()))
        assert.equal(upstream.size(), 1)

        // Aborting destroys the upstream request; the proxy must then end the
        // downstream SSE response so its socket drains and server.close can
        // complete. (The destroyed request emits 'error' on the backend request,
        // which the proxy turns into completion of the client response.)
        upstream.abortAll()
        await new Promise<void>((resolve, reject) => {
            res.once('close', () => resolve())
            res.once('end', () => resolve())
            setTimeout(() => reject(new Error('downstream response was not ended by the abort')), 1000).unref()
        })
        assert.equal(upstream.size(), 0)
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyGetRequest abort rejects the pending promise so callers do not hang', async () => {
    const backend = await startMockBackend(() => {/* hold the request open */})
    const upstream = createUpstreamTracker()
    try {
        const pending = proxyGetRequest(backend.baseUrl, 'k', '/models', upstream)
        await delay(50)
        assert.equal(upstream.size(), 1)
        upstream.abortAll()
        // destroying the request surfaces as a socket error on its own 'error'
        // path, which must settle the promise instead of leaving it pending
        await assert.rejects(pending, /socket hang up|ECONNRESET/i)
        assert.equal(upstream.size(), 0)
    } finally {
        await backend.close()
    }
})

test('proxyGetRequest abort mid-body settles the tracker and rejects', async () => {
    // Headers and a partial body, then hold the response open: the abort lands
    // after 'response' but before 'end', a path that may emit 'close' without
    // 'end' or 'error'.
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/plain'})
        res.write('partial')
    })
    const upstream = createUpstreamTracker()
    try {
        const pending = proxyGetRequest(backend.baseUrl, 'k', '/models', upstream)
        await delay(50)
        assert.equal(upstream.size(), 1)
        upstream.abortAll()
        await assert.rejects(pending)
        assert.equal(upstream.size(), 0)
    } finally {
        await backend.close()
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
        assert.equal(errors.some(msg => String(msg).startsWith('Backend request error:')), false)
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

test('proxyRequest relays only allowlisted client headers and replaces owned ones', async () => {
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
                'x-forwarded-for': '203.0.113.7',
                'x-custom-provider-flag': '1',
            },
        })
        const h = backend.requests[0].headers
        assert.equal(h['user-agent'], 'pi/0.1 test-agent')
        assert.equal(h['x-request-id'], 'req-123')
        assert.equal(h['accept'], 'text/event-stream')
        assert.equal(h.authorization, 'Bearer k')
        assert.equal(h['content-type'], 'application/json')
        assert.equal(h['content-length'], String(Buffer.byteLength('request-body')))
        // Everything not allowlisted is dropped, including the inbound proxy's
        // own metadata and headers the proxy owns.
        assert.equal(h['accept-encoding'], undefined)
        assert.equal(h.cookie, undefined)
        assert.equal(h['x-forwarded-for'], undefined)
        assert.equal(h['x-custom-provider-flag'], undefined)
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

test('proxyRequest answers 504 when the upstream never sends response headers', async () => {
    const backend = await startMockBackend(() => {
        // Hold the request open: never write headers or end.
    })
    const frontend = await startProxyFrontend({
        baseUrl: backend.baseUrl, apiKey: 'k', path: '/x',
        idleTimeoutMs: 100,
    })
    try {
        const {statusCode, body} = await rawRequest(frontend.port, '/x', {method: 'POST', body: '{}'})
        assert.equal(statusCode, 504)
        const json = JSON.parse(body) as {error: {type: string, message: string}}
        assert.equal(json.error.type, 'upstream_timeout')
        assert.match(json.error.message, /idle timeout after 100ms/)
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest ends the client response when the upstream stalls mid-stream', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write('data: first\n\n')
        // Then stall without ending, so only the idle deadline can settle it.
    })
    const frontend = await startProxyFrontend({
        baseUrl: backend.baseUrl, apiKey: 'k', path: '/x',
        idleTimeoutMs: 100,
    })
    try {
        const {statusCode, body} = await rawRequest(frontend.port, '/x', {method: 'POST', body: '{}'})
        assert.equal(statusCode, 200)
        assert.match(body, /^data: first\n\n/)
        const errorFrame = body.split('\n').find(line => line.startsWith('data: ') && line.includes('upstream_timeout'))
        assert.ok(errorFrame, 'expected an SSE data frame carrying the timeout error')
        const json = JSON.parse(errorFrame.slice('data: '.length)) as {error: {type: string}}
        assert.equal(json.error.type, 'upstream_timeout')
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest appends the timeout error body when a JSON response stalls mid-body', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.write('{"partial":')
        // Then stall without ending, so only the idle deadline can settle it.
    })
    const frontend = await startProxyFrontend({
        baseUrl: backend.baseUrl, apiKey: 'k', path: '/x',
        idleTimeoutMs: 100,
    })
    try {
        const {statusCode, body} = await rawRequest(frontend.port, '/x', {method: 'POST', body: '{}'})
        assert.equal(statusCode, 200)
        assert.match(body, /^\{"partial":\{"error":/)
        assert.match(body, /upstream_timeout/)
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyRequest keeps a slow but active stream alive past the idle window', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        let n = 0
        const timer = setInterval(() => {
            n += 1
            res.write(`data: ${n}\n\n`)
            if (n === 4) {
                clearInterval(timer)
                res.end()
            }
        }, 50)
    })
    const frontend = await startProxyFrontend({
        baseUrl: backend.baseUrl, apiKey: 'k', path: '/x',
        idleTimeoutMs: 200,
    })
    try {
        const {statusCode, body} = await rawRequest(frontend.port, '/x', {method: 'POST', body: '{}'})
        assert.equal(statusCode, 200)
        assert.equal(body, 'data: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\n')
    } finally {
        await frontend.close()
        await backend.close()
    }
})

test('proxyGetRequest rejects when the upstream never sends response headers', async () => {
    const backend = await startMockBackend(() => {
        // Never respond; only the idle deadline can settle it.
    })
    try {
        await assert.rejects(
            proxyGetRequest(backend.baseUrl, 'k', '/models', undefined, 100),
            /idle timeout after 100ms/,
        )
    } finally {
        await backend.close()
    }
})
