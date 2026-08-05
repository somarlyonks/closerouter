import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'
import {once} from 'events'
import {handleLogs, publishLog, type LogEntry} from '../lib/server/logs'
import {getFreePort, startCrServer, startHandlerServer, startMockBackend, sampleConfig, writeTempConfig} from './helpers'

test('GET /logs serves the HTML page without auth', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig(), apiKey: 'logkey'})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`)
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
        const body = await res.text()
        assert.match(body, /<!doctype html>/i)
        assert.match(body, /CloseRouter Logs/)
    } finally {
        await srv.close()
    }
})

test('GET /logs with SSE accept but no auth is rejected with 401', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig(), apiKey: 'logkey'})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`, {
            headers: {accept: 'text/event-stream'},
        })
        assert.equal(res.status, 401)
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'authentication_error')
    } finally {
        await srv.close()
    }
})

test('GET /logs SSE with wrong cookie is rejected with 401', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig(), apiKey: 'logkey'})
    try {
        const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
            const req = http.request(`http://127.0.0.1:${srv.port}/logs`, {
                method: 'GET',
                headers: {accept: 'text/event-stream', cookie: 'cr-key=wrong'},
            }, resolve)
            req.on('error', reject)
            req.end()
        })
        assert.equal(res.statusCode, 401)
        const body = await new Promise<string>((resolve, reject) => {
            let buf = ''
            res.on('data', (c: Buffer) => {
                buf += c.toString('utf-8')
            })
            res.on('end', () => resolve(buf))
            res.on('error', reject)
        })
        const json = JSON.parse(body) as {error: {type: string}}
        assert.equal(json.error.type, 'authentication_error')
    } finally {
        await srv.close()
    }
})

test('POST /logs is rejected with 405', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig(), apiKey: 'logkey'})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/logs`, {method: 'POST'})
        assert.equal(res.status, 405)
        assert.equal(res.headers.get('allow'), 'GET')
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'method_not_allowed')
    } finally {
        await srv.close()
    }
})

test('GET /logs SSE stream delivers published log events', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig(), apiKey: 'logkey'})
    try {
        const entry: LogEntry = {
            id: 'test',
            phase: 'response',
            time: '2026-01-01T00:00:00.000Z',
            method: 'GET',
            path: '/v1/models',
            status: 200,
            durationMs: 5,
        }

        const received = await new Promise<string>((resolve, reject) => {
            let done = false
            const req = http.request(`http://127.0.0.1:${srv.port}/logs`, {
                method: 'GET',
                headers: {accept: 'text/event-stream', cookie: 'cr-key=logkey'},
            }, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`expected status 200, got ${res.statusCode}`))
                    return
                }
                let buf = ''
                res.on('data', (chunk: Buffer) => {
                    buf += chunk.toString('utf-8')
                    if (buf.includes('"path":"/v1/models"')) {
                        done = true
                        req.destroy()
                        resolve(buf)
                    }
                })
                res.on('end', () => resolve(buf))
                res.on('error', reject)
            })
            req.on('error', reject)
            req.end()

            // The server registers its SSE listener synchronously while
            // processing the request, but under load that may take a few ticks
            // to reach the front of the event loop. Retry publishing until the
            // client acknowledges receipt (or the safety timeout elapses).
            const publisher = setInterval(() => {
                if (!done) publishLog(entry)
            }, 20)
            publisher.unref()
            const safety = setTimeout(() => {
                clearInterval(publisher)
                done = true
                req.destroy()
                resolve('')
            }, 2000)
            safety.unref()
        })

        assert.match(received, /event: log\n/)
        assert.match(received, /"path":"\/v1\/models"/)
        assert.match(received, /"status":200/)
    } finally {
        await srv.close()
    }
})

test('server logs capture request and response bodies', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write('data: {"choices":[]}\n\n')
        setTimeout(() => {
            res.write('data: [DONE]\n\n')
            res.end()
        }, 5)
    })
    const port = await getFreePort()
    const {path, cleanup} = await writeTempConfig({
        port,
        key: 'logkey',
        providers: {
            p: {base_url: backend.baseUrl, api_key: 'bk', models: [{id: 'm'}]},
        },
    })
    const srv = await startCrServer(path)
    try {
        let resolveEntries!: (entries: LogEntry[]) => void
        let rejectEntries!: (err: Error) => void
        const entriesPromise = new Promise<LogEntry[]>((resolve, reject) => {
            resolveEntries = resolve
            rejectEntries = reject
        })

        const sseReq = http.request(`http://127.0.0.1:${srv.port}/logs`, {
            headers: {accept: 'text/event-stream', cookie: 'cr-key=logkey'},
        }, (res) => {
            let buf = ''
            const timeout = setTimeout(() => {
                sseReq.destroy()
                rejectEntries(new Error('timed out waiting for log entries'))
            }, 3000)
            timeout.unref()
            let requestEntry: LogEntry | undefined
            let responseEntry: LogEntry | undefined
            res.on('data', (chunk: Buffer) => {
                buf += chunk.toString('utf-8')
                for (const entry of parseLogEvents(buf)) {
                    if (entry.path !== '/v1/chat/completions') continue
                    if (entry.phase === 'request') requestEntry = entry
                    if (entry.phase === 'response') responseEntry = entry
                }
                if (requestEntry && responseEntry) {
                    clearTimeout(timeout)
                    sseReq.destroy()
                    resolveEntries([requestEntry, responseEntry])
                }
            })
            res.on('error', rejectEntries)
        })
        sseReq.on('error', rejectEntries)
        sseReq.end()

        await once(sseReq, 'response')

        const res = await fetch(`http://127.0.0.1:${srv.port}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer logkey',
            },
            body: JSON.stringify({model: 'p/m', messages: []}),
        })
        assert.equal(res.status, 200)
        await res.text()

        const [requestEntry, responseEntry] = await entriesPromise
        assert.equal(requestEntry.requestBody, JSON.stringify({model: 'p/m', messages: []}))
        assert.equal(responseEntry.status, 200)
        assert.match(responseEntry.responseBody ?? '', /data: \{"choices":\[\]\}/)
        assert.equal(responseEntry.responseHeaders?.['content-type'], 'text/event-stream')
    } finally {
        await srv.close()
        await cleanup()
        await backend.close()
    }
})

function parseLogEvents (raw: string): LogEntry[] {
    const entries: LogEntry[] = []
    for (const block of raw.split('\n\n')) {
        const dataLine = block.split('\n').find(line => line.startsWith('data: '))
        if (!dataLine) continue
        try {
            entries.push(JSON.parse(dataLine.slice(6)) as LogEntry)
        } catch {
            // partial SSE frame; keep waiting for the rest
        }
    }
    return entries
}
