import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'events'
import {request} from 'http'
import type {IncomingMessage, ServerResponse} from 'http'
import {handleLogs, extractTokenUsage, logMiddleware} from '../lib/server/logs'
import {recordUsageEntry} from '../lib/server/logs/helper'
import type {UsageEntry} from '../lib/server/logs/db'
import {startHandlerServer, sampleConfig, startMockBackend, stubConsoleError, delay} from './helpers'

const sampleEntry = (): UsageEntry => ({
    requestId: 'req-1',
    time: 1_700_000_000_000,
    method: 'POST',
    path: '/v1/chat/completions',
    provider: 'p',
    model: 'm',
    status: 200,
})

test('GET /logs serves the HTML page without auth', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`)
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
        const body = await res.text()
        assert.match(body, /<!doctype html>/i)
        assert.match(body, /Logs/)
        assert.match(body, /Refresh/)
    } finally {
        await srv.close()
    }
})

test('GET /logs JSON history requires the API key', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`, {
            headers: {accept: 'application/json'},
        })
        assert.equal(res.status, 401)
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'authentication_error')
    } finally {
        await srv.close()
    }
})

test('GET /logs JSON history with a wrong key is rejected with 401', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`, {
            headers: {accept: 'application/json', authorization: 'Bearer wrong'},
        })
        assert.equal(res.status, 401)
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'authentication_error')
    } finally {
        await srv.close()
    }
})

test('GET /logs JSON history with a valid key returns the entries list', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        // No DB in a plain-node handler test - the list is empty but well-formed.
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`, {
            headers: {accept: 'application/json', authorization: 'Bearer logkey'},
        })
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'application/json')
        const json = await res.json() as {entries: unknown[]}
        assert.ok(Array.isArray(json.entries))
    } finally {
        await srv.close()
    }
})

test('GET /logs/<id> detail requires the API key', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs/1`, {
            headers: {accept: 'application/json'},
        })
        assert.equal(res.status, 401)
    } finally {
        await srv.close()
    }
})

test('GET /logs/<id> detail 404s for unknown or invalid ids', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        for (const path of ['/logs/1', '/logs/999999']) {
            const res = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
                headers: {accept: 'application/json', authorization: 'Bearer logkey'},
            })
            assert.equal(res.status, 404, `expected 404 for ${path}`)
        }
        for (const path of ['/logs/0', '/logs/-3', '/logs/abc']) {
            const res = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
                headers: {accept: 'application/json', authorization: 'Bearer logkey'},
            })
            assert.equal(res.status, 404, `expected 404 for ${path}`)
        }
    } finally {
        await srv.close()
    }
})

test('PUT /logs is rejected with 405', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`, {method: 'PUT'})
        assert.equal(res.status, 405)
        assert.equal(res.headers.get('allow'), 'GET, POST')
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'method_not_allowed')
    } finally {
        await srv.close()
    }
})

test('POST /logs tells the writer when the row cannot be stored', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`, {
            method: 'POST',
            headers: {'content-type': 'application/json', 'authorization': 'Bearer logkey'},
            body: JSON.stringify({
                requestId: 'req-1',
                time: 1_700_000_000_000,
                method: 'POST',
                path: '/v1/chat/completions',
                provider: 'p',
                model: 'm',
                status: 200,
                inputTokens: 3,
                outputTokens: 4,
                requestBody: 'hello',
                responseBody: 'world',
            }),
        })
        // Plain `npm test` runs without the sqlite symbols: a valid row is
        // accepted by validation but cannot be stored, and the writer has to
        // hear that instead of a hollow 201.
        assert.equal(res.status, 503)
        const json = await res.json() as {error: {type: string, message: string}}
        assert.equal(json.error.type, 'storage_unavailable')
        assert.match(json.error.message, /storage/i)
    } finally {
        await srv.close()
    }
})

test('POST /logs answers 503 when the instance has no db at all', async () => {
    const config = {...sampleConfig({key: 'logkey'}), dbPath: undefined}
    const srv = await startHandlerServer(handleLogs, {config})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`, {
            method: 'POST',
            headers: {'content-type': 'application/json', 'authorization': 'Bearer logkey'},
            body: JSON.stringify({requestId: 'req-1', time: 1, method: 'POST', path: '/v1/x'}),
        })
        assert.equal(res.status, 503)
    } finally {
        await srv.close()
    }
})

test('POST /logs stops reading a chunked upload that outgrows the cap', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        // A client that never ends its body must not pin the request open: the
        // server answers (or resets the socket) as soon as the cap is crossed.
        const outcome = await new Promise<string>((resolve) => {
            const req = request({
                hostname: '127.0.0.1',
                port: srv.port,
                path: '/logs',
                method: 'POST',
                headers: {'content-type': 'application/json', 'authorization': 'Bearer logkey'},
            }, (res) => {
                res.resume()
                resolve(`response ${res.statusCode}`)
            })
            req.on('error', (e: Error) => resolve(`error ${(e as NodeJS.ErrnoException).code}`))
            const chunk = Buffer.alloc(1024 * 1024, 0x20)
            for (let i = 0; i < 9; i++) req.write(chunk)
            setTimeout(() => resolve('still open'), 2000).unref()
        })
        assert.notEqual(outcome, 'still open', `the server kept reading a body it had already rejected (${outcome})`)
    } finally {
        await srv.close()
    }
})

test('POST /logs rejects a declared oversized entry without reading it', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        // the declaration is enough to reject: the server must not wait for the
        // body it was promised, and must retire the connection it cannot read
        const res = await new Promise<{status: number, connection: string | undefined, body: string}>((resolve, reject) => {
            const req = request({
                hostname: '127.0.0.1',
                port: srv.port,
                path: '/logs',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'authorization': 'Bearer logkey',
                    'content-length': String(8 * 1024 * 1024 + 1),
                },
            }, (upstreamRes) => {
                let body = ''
                upstreamRes.on('data', (c: Buffer) => {
                    body += c.toString('utf-8')
                })
                upstreamRes.on('end', () => resolve({
                    status: upstreamRes.statusCode ?? 0,
                    connection: upstreamRes.headers.connection,
                    body,
                }))
            })
            req.on('error', reject)
            req.end('{"requestId":"a"}')
        })
        assert.equal(res.status, 413)
        assert.equal(res.connection, 'close')
        assert.match(res.body, /payload_too_large/)
    } finally {
        await srv.close()
    }
})

test('POST /logs requires the API key', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: '{}',
        })
        assert.equal(res.status, 401)
    } finally {
        await srv.close()
    }
})

test('POST /logs rejects a malformed usage entry', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`, {
            method: 'POST',
            headers: {'content-type': 'application/json', 'authorization': 'Bearer logkey'},
            body: JSON.stringify({time: 1}),
        })
        assert.equal(res.status, 400)
        const json = await res.json() as {error: {message: string}}
        assert.match(json.error.message, /requestId/)
    } finally {
        await srv.close()
    }
})

test('log middleware recognizes canonicalized /v1 paths', () => {
    const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/../v1/chat/completions',
        headers: {'x-client-request-id': 'canonical-path'},
    }) as unknown as IncomingMessage
    const headers: Record<string, string> = {}
    const res = Object.assign(new EventEmitter(), {
        setHeader (name: string, value: string | number | readonly string[]) {
            headers[name.toLowerCase()] = String(value)
        },
    }) as unknown as ServerResponse

    logMiddleware({req, env: {config: sampleConfig()}, responseLog: {}}, res)

    assert.equal(headers['x-closerouter-request-id'], 'canonical-path')
})

test('recording a local db never opens a network connection', async () => {
    const backend = await startMockBackend()
    try {
        recordUsageEntry(sampleEntry(), sampleConfig({
            port: Number(new URL(backend.baseUrl).port),
            dbPath: ':memory:',
        }))
        await delay(50)
        assert.equal(backend.requests.length, 0, 'local storage is written in-process')
    } finally {
        await backend.close()
    }
})

test('a recording failure never escapes the response close handler', async () => {
    const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {},
    }) as unknown as IncomingMessage
    const res = Object.assign(new EventEmitter(), {
        setHeader () {},
        headersSent: false,
        statusCode: 200,
    }) as unknown as ServerResponse
    // A target the recorder cannot resolve makes posting throw synchronously;
    // that must stay inside the telemetry path instead of rejecting the promise
    // chained off the response close handler.
    const config = {...sampleConfig(), dbPath: 'upstream:not a url#k'}
    const errors = stubConsoleError()
    try {
        logMiddleware({req, env: {config}, responseLog: {provider: 'p', model: 'm', status: 200}}, res)
        req.emit('end')
        res.emit('close')
        await delay(20)
    } finally {
        errors.restore()
    }
    assert.ok(errors.errors.some(args => String(args[0]).includes('Failed to record usage')))
})

test('recording skips the usage API when the instance has no storage', async () => {
    const backend = await startMockBackend()
    try {
        recordUsageEntry(sampleEntry(), {
            ...sampleConfig({port: Number(new URL(backend.baseUrl).port)}),
            dbPath: undefined,
        })
        await delay(50)
        assert.equal(backend.requests.length, 0, 'a db-less standalone has nowhere to record')
    } finally {
        await backend.close()
    }
})

test('extractTokenUsage reads chat completions usage from a JSON body', () => {
    const body = JSON.stringify({
        usage: {prompt_tokens: 9, completion_tokens: 12, total_tokens: 21},
        choices: [],
    })
    assert.deepEqual(extractTokenUsage(body), {
        inputTokens: 9,
        outputTokens: 12,
    })
})

test('extractTokenUsage reads responses API usage from SSE frames', () => {
    const body = [
        'event: response.output_text.delta',
        'data: {"delta":"hi"}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","usage":{"input_tokens":125,"input_tokens_details":{"cached_tokens":100},"output_tokens":45}}',
        '',
    ].join('\n')
    assert.deepEqual(extractTokenUsage(body), {
        inputTokens: 125,
        outputTokens: 45,
        cachedTokens: 100,
    })
})

test('extractTokenUsage returns empty for bodies without usage', () => {
    assert.deepEqual(extractTokenUsage(undefined), {})
    assert.deepEqual(extractTokenUsage(''), {})
    assert.deepEqual(extractTokenUsage(JSON.stringify({foo: 'bar'})), {})
    assert.deepEqual(extractTokenUsage('data: {"delta":"hi"}\n\ndata: [DONE]\n\n'), {})
})
