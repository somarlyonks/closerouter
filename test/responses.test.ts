import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {Config} from '../lib/config'
import {handleResponses} from '../lib/server/v1/responses'
import {startMockBackend, startHandlerServer} from './helpers'

function configFor (baseUrl: string): Config {
    return {providers: {p: {base_url: baseUrl, api_key: 'bk'}}}
}

async function post (port: number, body: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST',
        body,
        headers: {'content-type': 'application/json'},
    })
}

test('responses rejects invalid JSON with 400', async () => {
    const srv = await startHandlerServer(handleResponses, {config: configFor('http://x'), apiKey: 'k'})
    try {
        const res = await post(srv.port, '{bad json')
        assert.equal(res.status, 400)
        const json = await res.json() as {error: {message: string, type: string}}
        assert.equal(json.error.type, 'invalid_request_error')
        assert.match(json.error.message, /invalid json/i)
    } finally {
        await srv.close()
    }
})

test('responses rejects a missing model with 400', async () => {
    const srv = await startHandlerServer(handleResponses, {config: configFor('http://x'), apiKey: 'k'})
    try {
        const res = await post(srv.port, JSON.stringify({input: 'hi'}))
        assert.equal(res.status, 400)
        const json = await res.json() as {error: {message: string}}
        assert.match(json.error.message, /missing.*model/i)
    } finally {
        await srv.close()
    }
})

test('responses rejects a model without a provider prefix with 404', async () => {
    const srv = await startHandlerServer(handleResponses, {config: configFor('http://x'), apiKey: 'k'})
    try {
        const res = await post(srv.port, JSON.stringify({model: 'foo'}))
        assert.equal(res.status, 404)
        const json = await res.json() as {error: {message: string, type: string}}
        assert.equal(json.error.type, 'model_not_found')
        assert.match(json.error.message, /Model "foo" is unavailable/)
    } finally {
        await srv.close()
    }
})

test('responses rejects an unknown provider with 404', async () => {
    const srv = await startHandlerServer(handleResponses, {config: configFor('http://x'), apiKey: 'k'})
    try {
        const res = await post(srv.port, JSON.stringify({model: 'unknown/x'}))
        assert.equal(res.status, 404)
        const json = await res.json() as {error: {message: string}}
        assert.match(json.error.message, /Provider "unknown" is not configured/)
    } finally {
        await srv.close()
    }
})

test('responses proxies to the backend with the provider prefix stripped', async () => {
    const backend = await startMockBackend((req, res) => {
        assert.equal(req.url, '/responses')
        assert.equal(req.method, 'POST')
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({id: 'resp_1', object: 'response'}))
    })
    const srv = await startHandlerServer(handleResponses, {config: configFor(backend.baseUrl), apiKey: 'k'})
    try {
        const res = await post(srv.port, JSON.stringify({
            model: 'p/gpt',
            input: 'hi',
        }))
        assert.equal(res.status, 200)
        const json = await res.json() as {id: string}
        assert.equal(json.id, 'resp_1')

        const sent = JSON.parse(backend.requests[0].body) as {model: string}
        assert.equal(sent.model, 'gpt')
        assert.equal(backend.requests[0].headers.authorization, 'Bearer bk')
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('responses streams backend chunks through to the client', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write('event: response.output_text.delta\n')
        res.write('data: {"delta":"hi"}\n\n')
        setTimeout(() => {
            res.write('data: [DONE]\n\n')
            res.end()
        }, 10)
    })
    const srv = await startHandlerServer(handleResponses, {config: configFor(backend.baseUrl), apiKey: 'k'})
    try {
        const res = await post(srv.port, JSON.stringify({
            model: 'p/gpt',
            stream: true,
            input: 'hi',
        }))
        const text = await res.text()
        assert.equal(
            text,
            'event: response.output_text.delta\ndata: {"delta":"hi"}\n\ndata: [DONE]\n\n',
        )
    } finally {
        await srv.close()
        await backend.close()
    }
})
