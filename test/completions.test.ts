import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {RuntimeConfig} from '../lib/config'
import {handleChatCompletions} from '../lib/server/v1/chat/completions'
import {startMockBackend, startHandlerServer} from './helpers'

function configFor (baseUrl: string): RuntimeConfig {
    return {raw: '', dbPath: '', port: 6712, key: 'k', providers: {p: {base_url: baseUrl, api_key: 'bk'}}}
}

async function post (port: number, body: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        body,
        headers: {'content-type': 'application/json'},
    })
}

test('chat completions rejects invalid JSON with 400', async () => {
    const srv = await startHandlerServer(handleChatCompletions, {config: configFor('http://x')})
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

test('chat completions rejects a missing model with 400', async () => {
    const srv = await startHandlerServer(handleChatCompletions, {config: configFor('http://x')})
    try {
        const res = await post(srv.port, JSON.stringify({messages: []}))
        assert.equal(res.status, 400)
        const json = await res.json() as {error: {message: string}}
        assert.match(json.error.message, /missing.*model/i)
    } finally {
        await srv.close()
    }
})

test('chat completions rejects a model without a provider prefix with 404', async () => {
    const srv = await startHandlerServer(handleChatCompletions, {config: configFor('http://x')})
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

test('chat completions rejects an unknown provider with 404', async () => {
    const srv = await startHandlerServer(handleChatCompletions, {config: configFor('http://x')})
    try {
        const res = await post(srv.port, JSON.stringify({model: 'unknown/x'}))
        assert.equal(res.status, 404)
        const json = await res.json() as {error: {message: string}}
        assert.match(json.error.message, /Provider "unknown" is not configured/)
    } finally {
        await srv.close()
    }
})

test('chat completions proxies to the backend with the provider prefix stripped', async () => {
    const backend = await startMockBackend((req, res) => {
        assert.equal(req.url, '/chat/completions')
        assert.equal(req.method, 'POST')
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({id: 'chatcmpl-1', choices: []}))
    })
    const srv = await startHandlerServer(handleChatCompletions, {config: configFor(backend.baseUrl)})
    try {
        const res = await post(srv.port, JSON.stringify({
            model: 'p/gpt',
            messages: [{role: 'user', content: 'hi'}],
        }))
        assert.equal(res.status, 200)
        const json = await res.json() as {id: string}
        assert.equal(json.id, 'chatcmpl-1')

        const sent = JSON.parse(backend.requests[0].body) as {model: string}
        assert.equal(sent.model, 'gpt')
        assert.equal(backend.requests[0].headers.authorization, 'Bearer bk')
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('chat completions streams backend chunks through to the client', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write('data: {"choices":[]}\n\n')
        setTimeout(() => {
            res.write('data: [DONE]\n\n')
            res.end()
        }, 10)
    })
    const srv = await startHandlerServer(handleChatCompletions, {config: configFor(backend.baseUrl)})
    try {
        const res = await post(srv.port, JSON.stringify({model: 'p/gpt', stream: true, messages: []}))
        const text = await res.text()
        assert.equal(text, 'data: {"choices":[]}\n\ndata: [DONE]\n\n')
    } finally {
        await srv.close()
        await backend.close()
    }
})
