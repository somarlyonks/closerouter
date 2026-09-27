// Telemetry parity tests: prove the persisted usage row and the published
// response log receive identical shared fields - status, provider/model,
// token counts, token-timestamp-derived ttft/generation, and bodies - for
// streaming, non-streaming, failed, and partially completed requests.
//
// The seam drives logMiddleware against real loopback req/res: scriptc cannot
// lower Object.assign/EventEmitter mocks or user-class casts to http builtins,
// so the harness runs a local http server whose handler captures the
// per-request responseLog (the very object proxy.ts accumulates into), calls
// logMiddleware exactly like lib/server/index does, and then dispatches either
// proxyRequest directly (mirroring proxyModelRequest's post-gate state) or
// the real v1 router. After the response closes, the row is read back via
// loadUsage/loadUsageBody and compared field-by-field against that log.
//
// These need the native SQLite symbols, so they only run when this file is
// compiled by scriptc with --ffi, e.g.
//   npx scriptc build test/telemetry.test.ts --ffi native/ffi.json -o dist/telemetry-test
// Under plain `npm test` (node, no sqlite) they are skipped with a placeholder.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer, request as httpRequest} from 'http'
import type {IncomingMessage, ServerResponse} from 'http'
import {sqliteAvailable, openDatabase} from '../lib/db'
import {initUsage, loadUsage, loadUsageBody} from '../lib/server/logs/db'
import type {UsageEntry} from '../lib/server/logs/db'
import {logMiddleware, extractTokenUsage} from '../lib/server/logs'
import type {ResponseLog} from '../lib/server/logs/helper'
import {MAX_BODY} from '../lib/server/logs/helper'
import {proxyRequest} from '../lib/proxy'
import {handle} from '../lib/router'
import type {RequestContext} from '../lib/router'
import {v1Router} from '../lib/server/v1'
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
        server.listen(0, '127.0.0.1', () => resolve({
            baseUrl: `http://127.0.0.1:${(server.address() as {port: number}).port}`,
            close: () => new Promise<void>(r => server.close(() => r())),
        }))
    })
}

interface Harness {
    port: number
    close: () => Promise<void>
    /** the responseLog captured for the most recent request */
    responseLog: () => ResponseLog | undefined
}

function harnessConfig (backendUrl: string): RuntimeConfig {
    return {
        port: 0,
        key: 'logkey',
        dbPath: ':memory:',
        retentionDays: 7,
        providers: {p: {base_url: backendUrl, api_key: 'bk'}},
    }
}

function listen (server: ReturnType<typeof createServer>, holder: {log?: ResponseLog}): Promise<Harness> {
    return new Promise((resolve, reject) => {
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => resolve({
            port: (server.address() as {port: number}).port,
            close: () => new Promise<void>(r => server.close(() => r())),
            responseLog: () => holder.log,
        }))
    })
}

/** Server that mirrors the production telemetry path minus the gate: each
 *  request gets a fresh captured responseLog, logMiddleware runs first (as in
 *  lib/server/index), provider/model are stamped (as proxyModelRequest does
 *  once the gate passes), and proxyRequest forwards to the backend. */
function startProxiedHarness (backendUrl: string, endpoint: string, requestBody: string): Promise<Harness> {
    const config = harnessConfig(backendUrl)
    const holder: {log?: ResponseLog} = {}
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const responseLog: ResponseLog = {}
        holder.log = responseLog
        logMiddleware({req, env: {config}, responseLog}, res)
        responseLog.provider = 'p'
        responseLog.model = 'm'
        proxyRequest(req, res, backendUrl, 'bk', endpoint, undefined, requestBody, responseLog)
    })
    return listen(server, holder)
}

/** Server running the full production stack for one request: logMiddleware
 *  plus the real v1 router (auth, gate, model rewrite, proxying). */
function startRoutedHarness (backendUrl: string): Promise<Harness> {
    const config = harnessConfig(backendUrl)
    const holder: {log?: ResponseLog} = {}
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const responseLog: ResponseLog = {}
        holder.log = responseLog
        const ctx: RequestContext = {req, env: {config}, responseLog}
        logMiddleware(ctx, res)
        handle(v1Router)(ctx, res)
    })
    return listen(server, holder)
}

interface UsageRow {
    entry: UsageEntry
    bodies: {requestBody?: string, responseBody?: string}
}

function findRow (requestId: string): UsageRow | undefined {
    const entry = loadUsage().find(e => e.requestId === requestId)
    if (entry === undefined) return undefined
    const bodies = loadUsageBody(entry.id as number)
    if (bodies === undefined) return undefined
    return {entry, bodies}
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25))

/** Read the persisted row for a request id, waiting out the asynchronous
 *  response-close that triggers persistence. */
async function rowFor (requestId: string): Promise<UsageRow> {
    const deadline = Date.now() + 2000
    let row = findRow(requestId)
    while (row === undefined && Date.now() < deadline) {
        await settle()
        row = findRow(requestId)
    }
    assert.ok(row !== undefined, `usage row for ${requestId} was not persisted in time`)
    return row!
}

function capturedLog (harness: Harness): ResponseLog {
    const log = harness.responseLog()
    assert.ok(log !== undefined, 'the harness captured the response log')
    return log!
}

/** The parity contract: every shared field of the persisted row is exactly
 *  what the accumulated response log holds. Token counts are asserted per
 *  scenario because their log-side source differs (incremental stream usage
 *  vs the extractTokenUsage body-parse fallback). */
function assertRowMirrorsLog (row: UsageRow, log: ResponseLog, requestBody: string, issuedAt: number): void {
    const entry = row.entry
    assert.equal(entry.method, 'POST')
    assert.equal(entry.path, '/v1/chat/completions')
    assert.ok(entry.time >= issuedAt, `row time ${entry.time} is the request start (issued after ${issuedAt})`)
    assert.ok(entry.time <= Date.now())
    assert.equal(entry.provider as string, log.provider as string)
    assert.equal(entry.model as string, log.model as string)
    assert.equal(entry.status as number, log.status as number)
    // ttft and generation are derived from the logged token timestamps against
    // the row's own start time; absent timestamps must yield absent fields
    if (log.firstTokenAt !== undefined) {
        assert.equal(entry.ttftMs as number, log.firstTokenAt - entry.time)
    } else {
        assert.ok(entry.ttftMs === undefined, 'no firstTokenAt means no ttftMs')
    }
    if (log.firstTokenAt !== undefined && log.lastTokenAt !== undefined) {
        assert.equal(entry.generationMs as number, log.lastTokenAt - log.firstTokenAt)
    } else {
        assert.ok(entry.generationMs === undefined, 'no lastTokenAt means no generationMs')
    }
    assert.ok(typeof entry.durationMs === 'number' && entry.durationMs >= 0)
    if (entry.ttftMs !== undefined) assert.ok(entry.ttftMs <= (entry.durationMs ?? 0), 'ttft never exceeds the total duration')
    // the persisted bodies are exactly the accumulated log body and the client request
    assert.equal(row.bodies.requestBody as string, requestBody)
    assert.equal(row.bodies.responseBody as string, log.body as string)
}

async function postJson (port: number, body: string, requestId: string) {
    return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'authorization': 'Bearer logkey',
            'x-client-request-id': requestId,
        },
        body,
    })
}

function telemetryTests (): void {
    test('streaming: SSE usage frame - row mirrors the accumulated response log', async () => {
        const backend = await startBackend((_req, res) => {
            res.writeHead(200, {'content-type': 'text/event-stream'})
            res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n')
            setTimeout(() => {
                res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22,"prompt_tokens_details":{"cached_tokens":5}}}\n\n')
                res.write('data: [DONE]\n\n')
                res.end()
            }, 10)
        })
        openDatabase(':memory:')
        initUsage()
        const requestBody = JSON.stringify({model: 'p/m', messages: []})
        const harness = await startProxiedHarness(backend.baseUrl, '/chat/completions', requestBody)
        try {
            const issuedAt = Date.now()
            const res = await postJson(harness.port, requestBody, 'telemetry-stream')
            assert.equal(res.status, 200)
            await res.text()

            const row = await rowFor('telemetry-stream')
            const log = capturedLog(harness)
            assertRowMirrorsLog(row, log, requestBody, issuedAt)

            // token counts come from the incremental SSE usage frame
            assert.equal(row.entry.inputTokens as number, 11)
            assert.equal(row.entry.outputTokens as number, 22)
            assert.equal(row.entry.cachedTokens as number, 5)
            assert.equal(row.entry.inputTokens as number, log.usage!.inputTokens as number)
            assert.equal(row.entry.outputTokens as number, log.usage!.outputTokens as number)
            assert.equal(row.entry.cachedTokens as number, log.usage!.cachedTokens as number)
            // both token timestamps were observed, so both derivations exist
            assert.ok(row.entry.ttftMs !== undefined)
            assert.ok(row.entry.generationMs !== undefined)
        } finally {
            await harness.close()
            await backend.close()
        }
    })

    test('non-streaming: JSON completion - row mirrors the log through the extractTokenUsage fallback', async () => {
        const backend = await startBackend((_req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                id: 'chatcmpl-1',
                object: 'chat.completion',
                usage: {prompt_tokens: 9, completion_tokens: 12, total_tokens: 21},
                choices: [],
            }))
        })
        openDatabase(':memory:')
        initUsage()
        const requestBody = JSON.stringify({model: 'p/m', messages: []})
        const harness = await startProxiedHarness(backend.baseUrl, '/chat/completions', requestBody)
        try {
            const issuedAt = Date.now()
            const res = await postJson(harness.port, requestBody, 'telemetry-json')
            assert.equal(res.status, 200)
            await res.text()

            const row = await rowFor('telemetry-json')
            const log = capturedLog(harness)
            assertRowMirrorsLog(row, log, requestBody, issuedAt)

            // a plain JSON body has no SSE frames, so no incremental usage was
            // collected - the row's tokens can only come from parsing the body
            assert.ok(log.usage !== undefined)
            assert.ok(log.usage!.inputTokens === undefined)
            assert.ok(log.usage!.outputTokens === undefined)
            const fallback = extractTokenUsage(log.body)
            assert.equal(row.entry.inputTokens as number, fallback.inputTokens as number)
            assert.equal(row.entry.outputTokens as number, fallback.outputTokens as number)
            assert.equal(row.entry.inputTokens as number, 9)
            assert.equal(row.entry.outputTokens as number, 12)
        } finally {
            await harness.close()
            await backend.close()
        }
    })

    test('failed: upstream 502 before headers - row mirrors the log status and error body', async () => {
        openDatabase(':memory:')
        initUsage()
        const requestBody = JSON.stringify({model: 'p/m', messages: []})
        // nothing listens on port 1 - the upstream dial fails before headers
        const harness = await startProxiedHarness('http://127.0.0.1:1', '/chat/completions', requestBody)
        try {
            const issuedAt = Date.now()
            const res = await postJson(harness.port, requestBody, 'telemetry-502')
            assert.equal(res.status, 502)
            await res.text()

            const row = await rowFor('telemetry-502')
            const log = capturedLog(harness)
            assertRowMirrorsLog(row, log, requestBody, issuedAt)

            assert.equal(log.status as number, 502)
            assert.match(log.body ?? '', /proxy_error/)
            // no upstream bytes arrived: no usage, no token timestamps
            assert.ok(row.entry.inputTokens === undefined)
            assert.ok(row.entry.outputTokens === undefined)
            assert.ok(row.entry.ttftMs === undefined)
            assert.ok(row.entry.generationMs === undefined)
        } finally {
            await harness.close()
        }
    })

    test('unrouted 400/404 responses are never persisted - the provider/model gate is the persistence gate', async () => {
        const backend = await startBackend((_req, res) => {
            res.writeHead(200, {'content-type': 'application/json'})
            res.end(JSON.stringify({id: 'chatcmpl-1', choices: []}))
        })
        openDatabase(':memory:')
        initUsage()
        const harness = await startRoutedHarness(backend.baseUrl)
        try {
            // a routed request through the real v1 router proves the seam
            // persists rows, so the absence assertions below are meaningful
            const routedBody = JSON.stringify({model: 'p/m', messages: []})
            const ok = await postJson(harness.port, routedBody, 'telemetry-routed-ok')
            assert.equal(ok.status, 200)
            await ok.text()
            await rowFor('telemetry-routed-ok')
            assert.equal(loadUsage().length, 1)

            // invalid JSON body: answered 400 by the proxy gate...
            const bad = await postJson(harness.port, 'not-json', 'telemetry-unrouted-400')
            assert.equal(bad.status, 400)
            await bad.text()
            // ...and an unconfigured provider: answered 404...
            const unknown = await postJson(harness.port, JSON.stringify({model: 'unknown/m'}), 'telemetry-unrouted-404')
            assert.equal(unknown.status, 404)
            await unknown.text()
            await settle()

            // ...but neither is persisted: the gate exits before stamping
            // provider/model onto the log, and logMiddleware drops such
            // requests silently. This pins that decision explicitly.
            assert.equal(loadUsage().length, 1)
            const log = capturedLog(harness)
            assert.ok(log.provider === undefined)
            assert.ok(log.model === undefined)
        } finally {
            await harness.close()
            await backend.close()
        }
    })

    test('partially completed: client aborts mid-stream - row mirrors the partial log without generationMs', async () => {
        const backend = await startBackend((_req, res) => {
            res.writeHead(200, {'content-type': 'text/event-stream'})
            res.write('data: {"delta":"partial","usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n')
            // never end - the generation is abandoned by the client
        })
        openDatabase(':memory:')
        initUsage()
        const requestBody = JSON.stringify({model: 'p/m', messages: []})
        const harness = await startProxiedHarness(backend.baseUrl, '/chat/completions', requestBody)
        try {
            const issuedAt = Date.now()
            await new Promise<void>((resolve) => {
                const upstream = httpRequest(
                    {
                        hostname: '127.0.0.1',
                        port: harness.port,
                        path: '/v1/chat/completions',
                        method: 'POST',
                        headers: {'content-type': 'application/json', 'x-client-request-id': 'telemetry-abort'},
                    },
                    (res) => {
                        res.on('data', () => {
                            res.destroy()
                            resolve()
                        })
                        res.on('error', () => {/* reset from our own destroy is expected */})
                    },
                )
                upstream.on('error', () => {/* the destroyed socket may error client-side too */})
                upstream.end(requestBody)
            })

            const row = await rowFor('telemetry-abort')
            const log = capturedLog(harness)
            assertRowMirrorsLog(row, log, requestBody, issuedAt)

            // headers and the first frame had already been published
            assert.equal(row.entry.status as number, 200)
            assert.equal(row.entry.inputTokens as number, 7)
            assert.equal(row.entry.outputTokens as number, 3)
            assert.ok(row.entry.ttftMs !== undefined)
            assert.match(row.bodies.responseBody ?? '', /partial/)
            // the stream never completed: no lastTokenAt, so no generationMs
            assert.ok(log.lastTokenAt === undefined)
            assert.ok(row.entry.generationMs === undefined)
        } finally {
            await harness.close()
            await backend.close()
        }
    })

    test('streaming: the response log and the row both cap the body at MAX_BODY', async () => {
        const backend = await startBackend((_req, res) => {
            res.writeHead(200, {'content-type': 'text/event-stream'})
            const chunk = 'x'.repeat(64 * 1024)
            for (let i = 0; i < 20; i++) res.write(chunk) // 1.25 MiB total
            res.end()
        })
        openDatabase(':memory:')
        initUsage()
        const requestBody = JSON.stringify({model: 'p/m', messages: []})
        const harness = await startProxiedHarness(backend.baseUrl, '/chat/completions', requestBody)
        try {
            const issuedAt = Date.now()
            const res = await postJson(harness.port, requestBody, 'telemetry-bounded')
            assert.equal(res.status, 200)
            await res.text()

            const row = await rowFor('telemetry-bounded')
            const log = capturedLog(harness)
            assertRowMirrorsLog(row, log, requestBody, issuedAt)

            assert.equal(log.body!.length, MAX_BODY)
            assert.equal(row.bodies.responseBody!.length, MAX_BODY)
            assert.equal(row.bodies.responseBody as string, log.body as string)
        } finally {
            await harness.close()
            await backend.close()
        }
    })
}

if (available) {
    telemetryTests()
} else {
    test('telemetry parity suite requires an FFI build (scriptc build test/telemetry.test.ts --ffi native/ffi.json)', () => {
        // Placeholder so `npm test` reports a visible skip instead of nothing.
    })
}
