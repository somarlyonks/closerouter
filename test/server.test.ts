import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn, type ChildProcess} from 'child_process'
import {Agent, get, type IncomingMessage} from 'node:http'
import {once} from 'events'
import {resolve, dirname} from 'path'
import {connect, type AddressInfo} from 'net'
import type {MockBackend} from './helpers'
import type {RuntimeConfig} from '../lib/config'
import {startServer} from '../lib/server'
import {handle, router, type RequestHandler} from '../lib/router'
import {startMockBackend, writeTempConfig, startCrServer, getFreePort, startHandlerServer, sampleConfig, stubConsoleError} from './helpers'

const API_KEY = 'sk-test'

async function setup (): Promise<{
    port: number
    backend: MockBackend
    close: () => Promise<void>
}> {
    const backend = await startMockBackend((req, res) => {
        if (req.method === 'GET' && req.url === '/models') {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({data: [{id: 'm'}]}))
        } else if (req.method === 'POST' && req.url === '/chat/completions') {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({id: 'chatcmpl-1', choices: []}))
        } else if (req.method === 'POST' && req.url === '/responses') {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({id: 'resp_1', object: 'response'}))
        } else {
            res.writeHead(404)
            res.end()
        }
    })
    const port = await getFreePort()
    const config: RuntimeConfig = {
        dbPath: '',
        retentionDays: 7,
        port,
        key: API_KEY,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: []}},
    }
    const srv = await startCrServer(config)
    return {
        port: srv.port,
        backend,
        close: async () => {
            await srv.close()
            await backend.close()
        },
    }
}

test('server binds 127.0.0.1 only and reports it as the bound address', async () => {
    const backend = await startMockBackend()
    const port = await getFreePort()
    const {server} = startServer({
        dbPath: '',
        retentionDays: 7,
        port,
        key: API_KEY,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: []}},
    })
    try {
        await once(server, 'listening')
        const addr = server.address() as AddressInfo
        assert.equal(addr.address, '127.0.0.1')
        assert.equal(addr.family, 'IPv4')
        // loopback connections work
        const res = await fetch(`http://127.0.0.1:${port}/status`)
        assert.equal(res.status, 200)
        // IPv6 loopback is refused - the server is not dual-stacked
        await new Promise<void>((resolveConnect, rejectConnect) => {
            const sock = connect({host: '::1', port})
            sock.once('connect', () => {
                sock.destroy()
                rejectConnect(new Error('::1 connect unexpectedly succeeded'))
            })
            sock.once('error', () => {
                sock.destroy()
                resolveConnect()
            })
        })
    } finally {
        await new Promise<void>(r => server.close(() => r()))
        await backend.close()
    }
})

test('startServer adds no process-wide signal listeners', async () => {
    const backend = await startMockBackend()
    const port = await getFreePort()
    const before = {
        sigint: process.listenerCount('SIGINT'),
        sigterm: process.listenerCount('SIGTERM'),
    }
    const {server} = startServer({
        dbPath: '',
        retentionDays: 7,
        port,
        key: API_KEY,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: []}},
    })
    try {
        await once(server, 'listening')
        // the shutdown sequence lives in the CLI server lifecycle; a reusable
        // startServer must not register handlers on the host process
        assert.equal(process.listenerCount('SIGINT'), before.sigint)
        assert.equal(process.listenerCount('SIGTERM'), before.sigterm)
    } finally {
        await new Promise<void>(r => server.close(() => r()))
        await backend.close()
    }
})

test('OPTIONS responds with CORS preflight headers', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/`, {
            method: 'OPTIONS',
            headers: {
                'origin': 'https://client.example',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'authorization, content-type, x-request-id',
            },
        })
        assert.equal(res.status, 204)
        assert.equal(res.headers.get('access-control-allow-origin'), '*')
        assert.match(res.headers.get('access-control-allow-methods') ?? '', /GET/)
        assert.equal(res.headers.get('access-control-allow-headers'), 'authorization, content-type, x-request-id')
    } finally {
        await s.close()
    }
})

test('v1 routes require authentication', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/v1/models`)
        assert.equal(res.status, 401)
    } finally {
        await s.close()
    }
})

test('GET /v1/models lists proxied and normalized models', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/v1/models`, {
            headers: {authorization: `Bearer ${API_KEY}`},
        })
        assert.equal(res.status, 200)
        const json = await res.json() as {object: string, data: unknown[]}
        assert.equal(json.object, 'list')
        assert.deepEqual(json.data, [{id: 'p/m', owned_by: 'p'}])
    } finally {
        await s.close()
    }
})

test('POST /v1/chat/completions routes to the backend with prefix stripped', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
            method: 'POST',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: JSON.stringify({model: 'p/m', messages: [{role: 'user', content: 'hi'}]}),
        })
        assert.equal(res.status, 200)
        assert.match(res.headers.get('x-closerouter-request-id') ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
        const json = await res.json() as {id: string}
        assert.equal(json.id, 'chatcmpl-1')
        const sent = JSON.parse(s.backend.requests[0].body) as {model: string}
        assert.equal(sent.model, 'm')
        assert.equal(s.backend.requests[0].headers.authorization, 'Bearer bk')
    } finally {
        await s.close()
    }
})

test('POST /v1/responses routes to the backend with prefix stripped', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/v1/responses`, {
            method: 'POST',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: JSON.stringify({model: 'p/m', input: 'hi'}),
        })
        assert.equal(res.status, 200)
        const json = await res.json() as {id: string}
        assert.equal(json.id, 'resp_1')
        const sent = JSON.parse(s.backend.requests[0].body) as {model: string}
        assert.equal(sent.model, 'm')
        assert.equal(s.backend.requests[0].headers.authorization, 'Bearer bk')
    } finally {
        await s.close()
    }
})

test('unknown routes return 404', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/unknown`)
        assert.equal(res.status, 404)
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'not_found')
    } finally {
        await s.close()
    }
})

test('GET /status returns ok without auth', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/status`)
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'application/json')
        const json = await res.json() as {status: string, sqlite?: string}
        assert.equal(json.status, 'ok')
        // the db is configured (in-memory '') but plain node has no SQLite
        // symbols, so the version probe fails silently and nothing is reported
        assert.equal(json.sqlite, undefined)
    } finally {
        await s.close()
    }
})

test('non-GET /status returns 405', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/status`, {method: 'POST'})
        assert.equal(res.status, 405)
        assert.equal(res.headers.get('allow'), 'GET')
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'method_not_allowed')
    } finally {
        await s.close()
    }
})

test('GET /logs serves the HTML page without auth', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/logs`)
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
    } finally {
        await s.close()
    }
})

test('error boundary answers a synchronous throw with a 500 before headers are sent', async () => {
    const stub = stubConsoleError()
    let srv
    try {
        srv = await startHandlerServer((() => {
            throw new Error('sync boom')
        }) as RequestHandler, sampleConfig())
        const res = await fetch(`http://127.0.0.1:${srv.port}/`)
        assert.equal(res.status, 500)
        assert.deepEqual(await res.json(), {
            error: {message: 'Internal server error', type: 'server_error'},
        })
    } finally {
        stub.restore()
        await srv?.close()
    }
    assert.equal(stub.errors.length, 1)
    assert.equal((stub.errors[0]![0] as Error).message, 'sync boom')
})

test('error boundary answers an un-adapted rejected handler promise with a 500', async () => {
    const stub = stubConsoleError()
    let srv
    try {
        srv = await startHandlerServer(async () => {
            throw new Error('async boom')
        }, sampleConfig())
        const res = await fetch(`http://127.0.0.1:${srv.port}/`)
        assert.equal(res.status, 500)
        assert.deepEqual(await res.json(), {
            error: {message: 'Internal server error', type: 'server_error'},
        })
    } finally {
        stub.restore()
        await srv?.close()
    }
    assert.equal(stub.errors.length, 1)
    assert.equal((stub.errors[0]![0] as Error).message, 'async boom')
})

test('error boundary terminates a started response instead of faking a clean EOF', async () => {
    const stub = stubConsoleError()
    let srv
    try {
        srv = await startHandlerServer(async (_ctx, res) => {
            res.writeHead(200, {'content-type': 'text/plain'})
            res.write('partial')
            await new Promise<void>(r => setTimeout(r, 20))
            throw new Error('mid-stream boom')
        }, sampleConfig())
        await assert.rejects(async () => {
            const res = await fetch(`http://127.0.0.1:${srv.port}/`)
            assert.equal(res.status, 200)
            // the truncated body read must fail: the client must not receive a
            // clean EOF after a partial body
            await res.text()
        })
    } finally {
        stub.restore()
        await srv?.close()
    }
    assert.equal(stub.errors.length, 1)
    assert.equal((stub.errors[0]![0] as Error).message, 'mid-stream boom')
})

test('error boundary settles an un-adapted async route handler rejection exactly once', async () => {
    const stub = stubConsoleError()
    let srv
    try {
        // the production composition: the boundary wraps the dispatch, the
        // dispatch settles the route handler's promise
        srv = await startHandlerServer(handle(
            router(() => true, async () => {
                throw new Error('route boom')
            }),
        ), sampleConfig())
        const res = await fetch(`http://127.0.0.1:${srv.port}/`)
        assert.equal(res.status, 500)
        assert.deepEqual(await res.json(), {
            error: {message: 'Internal server error', type: 'server_error'},
        })
    } finally {
        stub.restore()
        await srv?.close()
    }
    // the dispatch settles the failure; the boundary must not log it again
    assert.equal(stub.errors.length, 1)
    assert.equal((stub.errors[0]![0] as Error).message, 'route boom')
})

test('SIGTERM triggers graceful shutdown with exit code 0', async () => {
    const port = await getFreePort()
    const {path, cleanup} = await writeTempConfig({
        port,
        key: API_KEY,
        providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'bk', models: []}},
    })
    const child = spawn(process.execPath, [
        '--import', resolve(process.cwd(), 'test/loader.mjs'),
        resolve(process.cwd(), 'lib/cli.ts'),
    ], {
        // main() resolves the config from cwd, so run from the temp dir.
        cwd: dirname(path),
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
        const out = await waitForReady(child)
        // the startup banner reports the actual loopback bind address
        assert.match(out, /closerouter running on http:\/\/127\.0\.0\.1:\d+/)
        child.kill('SIGTERM')
        const [code, signal] = await once(child, 'exit')
        assert.equal(code, 0)
        assert.equal(signal, null)
    } finally {
        if (child.exitCode === null) child.kill('SIGKILL')
        await cleanup()
    }
})

test('in-flight request drains before graceful shutdown completes', async () => {
    const backend = await startMockBackend((req, res) => {
        if (req.method === 'POST' && req.url === '/chat/completions') {
            // Hold the response open so the request is still in flight when we signal.
            setTimeout(() => {
                res.writeHead(200, {'content-type': 'application/json'})
                res.end(JSON.stringify({id: 'chatcmpl-1', choices: []}))
            }, 200)
        } else {
            res.writeHead(404).end()
        }
    })
    const port = await getFreePort()
    const {path, cleanup} = await writeTempConfig({
        port,
        key: API_KEY,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: []}},
    })
    const child = spawn(process.execPath, [
        '--import', resolve(process.cwd(), 'test/loader.mjs'),
        resolve(process.cwd(), 'lib/cli.ts'),
    ], {
        cwd: dirname(path),
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf-8')
    })
    try {
        await waitForReady(child)
        // Kick off a request whose backend response resolves after 200ms; send
        // SIGTERM while it is still pending and verify the client still gets it.
        const responsePromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: JSON.stringify({model: 'p/m', messages: []}),
        })
        // Wait for the backend to receive the request so SIGTERM lands while it
        // is genuinely in flight (server.close drains it instead of rejecting).
        await waitForBackendRequest(backend, stderr)
        child.kill('SIGTERM')
        const res = await responsePromise
        assert.equal(res.status, 200)
        const json = await res.json() as {id: string}
        assert.equal(json.id, 'chatcmpl-1')
        const [code, signal] = await once(child, 'exit')
        assert.equal(code, 0)
        assert.equal(signal, null)
    } finally {
        if (child.exitCode === null) child.kill('SIGKILL')
        await backend.close()
        await cleanup()
    }
})

// One GET /status over a keep-alive agent; resolves once the response is fully
// consumed, leaving the socket parked in the agent's pool.
function requestStatus (port: number, agent: Agent): Promise<IncomingMessage> {
    return new Promise((resolveRequest, rejectRequest) => {
        const req = get({host: '127.0.0.1', port, path: '/status', agent}, (res) => {
            res.on('end', () => resolveRequest(res))
            res.resume()
        })
        req.on('error', rejectRequest)
    })
}

test('closeIdleConnections retires a parked keep-alive socket so server.close completes', async () => {
    const backend = await startMockBackend()
    const port = await getFreePort()
    const {server} = startServer({
        dbPath: '',
        retentionDays: 7,
        port,
        key: API_KEY,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: []}},
    })
    const agent = new Agent({keepAlive: true})
    try {
        await once(server, 'listening')
        const res = await requestStatus(port, agent)
        assert.equal(res.statusCode, 200)
        // The socket is parked in the agent; closeIdleConnections retires it so
        // server.close completes now instead of waiting out the keep-alive timeout.
        const closed = new Promise<void>(r => server.close(() => r()))
        server.closeIdleConnections()
        await Promise.race([
            closed,
            new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('server.close did not complete: parked socket was not retired')), 2000).unref()
            }),
        ])
    } finally {
        agent.destroy()
        await new Promise<void>(r => server.close(() => r()))
        await backend.close()
    }
})

test('SIGTERM exits 0 promptly with a parked keep-alive client', async () => {
    const port = await getFreePort()
    const {path, cleanup} = await writeTempConfig({
        port,
        key: API_KEY,
        providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'bk', models: []}},
    })
    const child = spawn(process.execPath, [
        '--import', resolve(process.cwd(), 'test/loader.mjs'),
        resolve(process.cwd(), 'lib/cli.ts'),
    ], {
        cwd: dirname(path),
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    const agent = new Agent({keepAlive: true})
    try {
        await waitForReady(child)
        await requestStatus(port, agent)
        // The keep-alive socket stays parked in the test process; the child must
        // still exit cleanly now instead of waiting out the keep-alive timeout
        // (or the force-exit grace period).
        const started = Date.now()
        child.kill('SIGTERM')
        const [code, signal] = await once(child, 'exit')
        assert.equal(code, 0)
        assert.equal(signal, null)
        const elapsed = Date.now() - started
        assert.ok(elapsed < 5000, `shutdown took ${elapsed}ms: parked socket was not retired`)
    } finally {
        agent.destroy()
        if (child.exitCode === null) child.kill('SIGKILL')
        await cleanup()
    }
})

// Poll the mock backend until it has recorded at least one request, so the test
// can signal the proxy knowing the request is genuinely in flight.
function waitForBackendRequest (backend: MockBackend, stderr: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
        const start = Date.now()
        const tick = () => {
            if (backend.requests.length > 0) return resolve()
            if (Date.now() - start > timeoutMs) {
                return reject(new Error(`backend never received request; child stderr: ${stderr}`))
            }
            setTimeout(tick, 5)
        }
        tick()
    })
}

// Resolve with the captured stdout once the child server has printed its
// "running" banner, so the caller knows it is listening and signal handlers are
// registered. Rejects if the child exits before becoming ready.
function waitForReady (child: ChildProcess, timeoutMs = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
        let buf = ''
        const onStdout = (c: Buffer) => {
            buf += c.toString('utf-8')
            if (buf.includes('closerouter running on')) {
                clearTimeout(timer)
                child.stdout!.off('data', onStdout)
                child.off('exit', onExit)
                resolve(buf)
            }
        }
        const onExit = (code: number | null) => {
            clearTimeout(timer)
            reject(new Error(`server exited before ready (code=${code})`))
        }
        const timer = setTimeout(() => {
            child.stdout!.off('data', onStdout)
            child.off('exit', onExit)
            reject(new Error('server did not become ready in time'))
        }, timeoutMs)
        timer.unref()
        child.stdout!.on('data', onStdout)
        child.on('exit', onExit)
    })
}
