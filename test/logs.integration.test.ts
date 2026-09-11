// End-to-end log capture tests: POST a /v1 request through a real server +
// mock backend, then verify the completed request landed in the usage DB and is
// served by the authenticated GET /logs history + /logs/<id> detail endpoints.
//
// These need the native SQLite symbols, so they only run when this file is
// compiled by scriptc with --ffi, e.g.
//   npx scriptc build test/logs.integration.test.ts --ffi native/ffi.json -o dist/logs-test
// Under plain `npm test` (node, no sqlite) they are skipped with a placeholder.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {IncomingMessage, ServerResponse} from 'http'
import {createServer} from 'http'
import {sqliteAvailable, openDatabase} from '../lib/db'
import {initUsage} from '../lib/server/logs/db'
import {startServer} from '../lib/server'
import type {RuntimeConfig} from '../lib/config'

const available = sqliteAvailable()

interface Backend {
    baseUrl: string
    close: () => Promise<void>
}

function startBackend (handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Backend> {
    const server = createServer(handler)
    return new Promise((resolve, reject) => {
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as {port: number}).port
            resolve({
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise<void>(r => server.close(() => r())),
            })
        })
    })
}

function listen (server: ReturnType<typeof startServer>): Promise<number> {
    return new Promise(resolve => server.on('listening', () => resolve((server.address() as {port: number}).port)))
}

function configFor (backend: string): RuntimeConfig {
    return {
        raw: '',
        port: 0,
        key: 'logkey',
        dbPath: '',
        retentionDays: 7,
        providers: {
            p: {base_url: backend, api_key: 'bk', models: [{id: 'm'}]},
        },
    }
}

interface HistoryEntry {
    id: number
    requestId: string
    time: number
    method: string
    path: string
    provider?: string
    model?: string
    status?: number
    durationMs?: number
    ttftMs?: number
    generationMs?: number
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
}

async function fetchHistory (port: number, key: string): Promise<HistoryEntry[]> {
    const res = await fetch(`http://127.0.0.1:${port}/logs`, {
        headers: {accept: 'application/json', authorization: `Bearer ${key}`},
    })
    assert.equal(res.status, 200)
    const payload = await res.json() as {entries: HistoryEntry[]}
    return payload.entries
}

async function fetchDetail (port: number, key: string, id: number): Promise<{requestBody?: string, responseBody?: string}> {
    const res = await fetch(`http://127.0.0.1:${port}/logs/${id}`, {
        headers: {accept: 'application/json', authorization: `Bearer ${key}`},
    })
    assert.equal(res.status, 200)
    return res.json() as Promise<{requestBody?: string, responseBody?: string}>
}

function integrationTests (): void {
    test('chat completion bodies are captured and served by history/detail', async () => {
        const backend = await startBackend((_req, res) => {
            res.writeHead(200, {'content-type': 'text/event-stream'})
            res.write('data: {"choices":[]}\n\n')
            setTimeout(() => {
                res.write('data: [DONE]\n\n')
                res.end()
            }, 5)
        })
        openDatabase('')
        initUsage()
        const server = startServer(configFor(backend.baseUrl))
        const port = await listen(server)
        try {
            const body = JSON.stringify({model: 'p/m', messages: []})
            const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'authorization': 'Bearer logkey',
                    'x-client-request-id': 'client-abc-123',
                },
                body,
            })
            assert.equal(res.status, 200)
            assert.equal(res.headers.get('x-closerouter-request-id'), 'client-abc-123')
            await res.text()

            const entries = await fetchHistory(port, 'logkey')
            const found = entries.find(e => e.requestId === 'client-abc-123')
            assert.ok(found, 'history row for the request exists')
            const entry = found!
            assert.equal(entry.method, 'POST')
            assert.equal(entry.path, '/v1/chat/completions')
            assert.ok(entry.provider === 'p', 'provider is p')
            assert.ok(entry.model === 'm', 'model is m')
            assert.ok(entry.status === 200, 'status is 200')
            assert.ok(typeof entry.durationMs === 'number', 'durationMs is a number')
            assert.ok((entry.ttftMs ?? 0) >= 0)

            const detail = await fetchDetail(port, 'logkey', entry.id)
            assert.ok(detail.requestBody === body, 'request body is captured verbatim')
            assert.match(detail.responseBody ?? '', /data: \{"choices":\[\]\}/)
        } finally {
            await new Promise<void>(r => server.close(() => r()))
            await backend.close()
        }
    })

    test('responses stream usage is captured and recorded in logs', async () => {
        const backend = await startBackend((_req, res) => {
            res.writeHead(200, {'content-type': 'text/event-stream'})
            res.write('event: response.output_text.delta\n')
            res.write('data: {"delta":"hi"}\n\n')
            setTimeout(() => {
                res.write('event: response.completed\n')
                res.write('data: {"type":"response.completed","id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":125,"input_tokens_details":{"cached_tokens":100},"output_tokens":45,"total_tokens":170}}\n\n')
                res.end()
            }, 5)
        })
        openDatabase('')
        initUsage()
        const server = startServer(configFor(backend.baseUrl))
        const port = await listen(server)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'authorization': 'Bearer logkey',
                },
                body: JSON.stringify({model: 'p/m', stream: true, input: 'hi'}),
            })
            assert.equal(res.status, 200)
            await res.text()

            const entries = await fetchHistory(port, 'logkey')
            const found = entries.find(e => e.path === '/v1/responses')
            assert.ok(found, 'history row for the responses request exists')
            const entry = found!
            assert.ok(entry.status === 200, 'status is 200')
            assert.ok(entry.inputTokens === 125, 'inputTokens is 125')
            assert.ok(entry.outputTokens === 45, 'outputTokens is 45')
            assert.ok(entry.cachedTokens === 100, 'cachedTokens is 100')

            const detail = await fetchDetail(port, 'logkey', entry.id)
            assert.match(detail.responseBody ?? '', /response\.completed/)
        } finally {
            await new Promise<void>(r => server.close(() => r()))
            await backend.close()
        }
    })

    test('non-streaming chat completion token usage is captured and recorded in logs', async () => {
        const backend = await startBackend((_req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                model: 'm',
                usage: {prompt_tokens: 9, completion_tokens: 12, total_tokens: 21},
                choices: [{index: 0, message: {role: 'assistant', content: 'hi'}, finish_reason: 'stop'}],
            }))
        })
        openDatabase('')
        initUsage()
        const server = startServer(configFor(backend.baseUrl))
        const port = await listen(server)
        try {
            const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'authorization': 'Bearer logkey',
                },
                body: JSON.stringify({model: 'p/m', messages: []}),
            })
            assert.equal(res.status, 200)
            await res.text()

            const entries = await fetchHistory(port, 'logkey')
            const found = entries.find(e => e.path === '/v1/chat/completions')
            assert.ok(found, 'history row for the request exists')
            const entry = found!
            assert.ok(entry.status === 200, 'status is 200')
            assert.ok(entry.inputTokens === 9, 'inputTokens is 9')
            assert.ok(entry.outputTokens === 12, 'outputTokens is 12')

            const detail = await fetchDetail(port, 'logkey', entry.id)
            assert.match(detail.responseBody ?? '', /"usage"/)
        } finally {
            await new Promise<void>(r => server.close(() => r()))
            await backend.close()
        }
    })
}

if (available) {
    integrationTests()
} else {
    test('logs integration suite requires an FFI build (scriptc build test/logs.integration.test.ts --ffi native/ffi.json)', () => {
        // Placeholder so `npm test` reports a visible skip instead of nothing.
    })
}
