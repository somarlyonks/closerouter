/* eslint-disable eslint-plugin-no-null/no-null */

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn, type ChildProcess} from 'child_process'
import {once} from 'events'
import {resolve, dirname} from 'path'
import type {MockBackend} from './helpers'
import type {RuntimeConfig} from '../lib/config'
import {startMockBackend, writeTempConfig, startCrServer, getFreePort} from './helpers'

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
        path: '',
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

test('OPTIONS responds with CORS preflight headers', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/`, {method: 'OPTIONS'})
        assert.equal(res.status, 204)
        assert.equal(res.headers.get('access-control-allow-origin'), '*')
        assert.match(res.headers.get('access-control-allow-methods') ?? '', /GET/)
        assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/)
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
        const json = await res.json() as {status: string}
        assert.equal(json.status, 'ok')
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
        await waitForReady(child)
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

// Resolve once the child server has printed its "running" banner, so the caller
// knows it is listening and signal handlers are registered. Rejects if the child
// exits before becoming ready.
function waitForReady (child: ChildProcess, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
        let buf = ''
        const onStdout = (c: Buffer) => {
            buf += c.toString('utf-8')
            if (buf.includes('closerouter running on')) {
                clearTimeout(timer)
                child.stdout!.off('data', onStdout)
                child.off('exit', onExit)
                resolve()
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
