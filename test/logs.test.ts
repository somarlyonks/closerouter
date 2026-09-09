import {test} from 'node:test'
import assert from 'node:assert/strict'
import {handleLogs, extractTokenUsage} from '../lib/server/logs'
import {startHandlerServer, sampleConfig} from './helpers'

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

test('POST /logs is rejected with 405', async () => {
    const srv = await startHandlerServer(handleLogs, {config: sampleConfig({key: 'logkey'})})
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
