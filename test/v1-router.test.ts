import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {RuntimeConfig} from '../lib/config'
import {v1Router} from '../lib/server/v1'
import {startMockBackend, startHandlerServer} from './helpers'

function configFor (baseUrl: string): RuntimeConfig {
    return {
        raw: '', port: 6712, key: 'k', dbPath: undefined,
        providers: {p: {base_url: baseUrl, api_key: 'bk'}},
    }
}

// v1Router is wrapped in needsAuth, so requests need `Authorization: Bearer k`.
async function request (port: number, path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: {authorization: 'Bearer k', ...(init?.headers ?? {})},
    })
}

test('v1 router requires authentication', async () => {
    const srv = await startHandlerServer(v1Router, {config: configFor('http://x')})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/v1/chat/completions`, {
            method: 'POST',
            body: JSON.stringify({model: 'p/gpt'}),
            headers: {'content-type': 'application/json'},
        })
        assert.equal(res.status, 401)
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'authentication_error')
    } finally {
        await srv.close()
    }
})

test('v1 router forwards POST /v1/chat/completions with the provider prefix stripped', async () => {
    const backend = await startMockBackend((req, res) => {
        assert.equal(req.url, '/chat/completions')
        assert.equal(req.method, 'POST')
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({id: 'chatcmpl-1', choices: []}))
    })
    const srv = await startHandlerServer(v1Router, {config: configFor(backend.baseUrl)})
    try {
        const res = await request(srv.port, '/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({model: 'p/gpt', messages: [{role: 'user', content: 'hi'}]}),
            headers: {'content-type': 'application/json'},
        })
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

test('v1 router forwards POST /v1/responses with the provider prefix stripped', async () => {
    const backend = await startMockBackend((req, res) => {
        assert.equal(req.url, '/responses')
        assert.equal(req.method, 'POST')
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({id: 'resp_1', object: 'response'}))
    })
    const srv = await startHandlerServer(v1Router, {config: configFor(backend.baseUrl)})
    try {
        const res = await request(srv.port, '/v1/responses', {
            method: 'POST',
            body: JSON.stringify({model: 'p/gpt', input: 'hi'}),
            headers: {'content-type': 'application/json'},
        })
        assert.equal(res.status, 200)
        const json = await res.json() as {id: string}
        assert.equal(json.id, 'resp_1')

        const sent = JSON.parse(backend.requests[0].body) as {model: string}
        assert.equal(sent.model, 'gpt')
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('v1 router preserves query strings when forwarding', async () => {
    const backend = await startMockBackend((req, res) => {
        assert.equal(req.url, '/chat/completions?foo=bar')
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({id: 'chatcmpl-1'}))
    })
    const srv = await startHandlerServer(v1Router, {config: configFor(backend.baseUrl)})
    try {
        const res = await request(srv.port, '/v1/chat/completions?foo=bar', {
            method: 'POST',
            body: JSON.stringify({model: 'p/gpt'}),
            headers: {'content-type': 'application/json'},
        })
        assert.equal(res.status, 200)
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('v1 router forwards any other POST path under /v1 to the backend', async () => {
    const backend = await startMockBackend((req, res) => {
        assert.equal(req.url, '/embeddings')
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({object: 'list'}))
    })
    const srv = await startHandlerServer(v1Router, {config: configFor(backend.baseUrl)})
    try {
        const res = await request(srv.port, '/v1/embeddings', {
            method: 'POST',
            body: JSON.stringify({model: 'p/gpt', input: 'hi'}),
            headers: {'content-type': 'application/json'},
        })
        assert.equal(res.status, 200)
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('v1 router rejects non-POST requests to /v1/* with 405', async () => {
    const srv = await startHandlerServer(v1Router, {config: configFor('http://x')})
    try {
        const res = await request(srv.port, '/v1/chat/completions')
        assert.equal(res.status, 405)
        assert.equal(res.headers.get('allow'), 'POST')
    } finally {
        await srv.close()
    }
})

test('v1 router serves GET /v1/models', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({data: [{id: 'm1'}]}))
    })
    const srv = await startHandlerServer(v1Router, {config: configFor(backend.baseUrl)})
    try {
        const res = await request(srv.port, '/v1/models')
        assert.equal(res.status, 200)
        const json = await res.json() as {data: unknown[]}
        assert.deepEqual(json.data, [{id: 'p/m1', owned_by: 'p'}])
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('v1 router rejects invalid JSON with 400', async () => {
    const srv = await startHandlerServer(v1Router, {config: configFor('http://x')})
    try {
        const res = await request(srv.port, '/v1/chat/completions', {
            method: 'POST',
            body: '{bad json',
            headers: {'content-type': 'application/json'},
        })
        assert.equal(res.status, 400)
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'invalid_request_error')
    } finally {
        await srv.close()
    }
})

test('v1 router rejects a missing model with 400', async () => {
    const srv = await startHandlerServer(v1Router, {config: configFor('http://x')})
    try {
        const res = await request(srv.port, '/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({messages: []}),
            headers: {'content-type': 'application/json'},
        })
        assert.equal(res.status, 400)
        const json = await res.json() as {error: {message: string}}
        assert.match(json.error.message, /missing.*model/i)
    } finally {
        await srv.close()
    }
})

test('v1 router rejects a model without a provider prefix with 404', async () => {
    const srv = await startHandlerServer(v1Router, {config: configFor('http://x')})
    try {
        const res = await request(srv.port, '/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({model: 'foo'}),
            headers: {'content-type': 'application/json'},
        })
        assert.equal(res.status, 404)
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'model_not_found')
    } finally {
        await srv.close()
    }
})

test('v1 router rejects an unknown provider with 404', async () => {
    const srv = await startHandlerServer(v1Router, {config: configFor('http://x')})
    try {
        const res = await request(srv.port, '/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({model: 'unknown/x'}),
            headers: {'content-type': 'application/json'},
        })
        assert.equal(res.status, 404)
        const json = await res.json() as {error: {message: string}}
        assert.match(json.error.message, /Provider "unknown" is not configured/)
    } finally {
        await srv.close()
    }
})

test('v1 router streams backend chunks through to the client', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'text/event-stream'})
        res.write('data: {"choices":[]}\n\n')
        setTimeout(() => {
            res.write('data: [DONE]\n\n')
            res.end()
        }, 10)
    })
    const srv = await startHandlerServer(v1Router, {config: configFor(backend.baseUrl)})
    try {
        const res = await request(srv.port, '/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({model: 'p/gpt', stream: true, messages: []}),
            headers: {'content-type': 'application/json'},
        })
        const text = await res.text()
        assert.equal(text, 'data: {"choices":[]}\n\ndata: [DONE]\n\n')
    } finally {
        await srv.close()
        await backend.close()
    }
})
