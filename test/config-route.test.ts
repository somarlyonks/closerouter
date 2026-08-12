import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'fs'
import {loadConfig} from '../lib/config'
import {getFreePort, startCrServer, writeTempConfig} from './helpers'

const API_KEY = 'sk-test'

async function setup (): Promise<{
    port: number
    path: string
    cleanup: () => Promise<void>
    close: () => Promise<void>
}> {
    const port = await getFreePort()
    const {path, cleanup} = await writeTempConfig({
        port,
        key: API_KEY,
        providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'bk', models: []}},
    })
    const srv = await startCrServer(loadConfig(path))
    return {
        port: srv.port,
        path,
        cleanup,
        close: async () => {
            await srv.close()
            await cleanup()
        },
    }
}

test('PUT /config requires authentication', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/config`, {
            method: 'PUT',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({providers: {p: {base_url: 'http://x', api_key: 'k'}}}),
        })
        assert.equal(res.status, 401)
    } finally {
        await s.close()
    }
})

test('GET /config serves the HTML page', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/config`)
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
        const body = await res.text()
        assert.match(body, /Config/)
    } finally {
        await s.close()
    }
})

test('GET /config with accept json requires authentication', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/config`, {
            headers: {accept: 'application/json'},
        })
        assert.equal(res.status, 401)
    } finally {
        await s.close()
    }
})

test('GET /config with accept json returns the running config', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/config`, {
            headers: {authorization: `Bearer ${API_KEY}`, accept: 'application/json'},
        })
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'application/json')
        const json = await res.json() as {port: number, key: string, providers: Record<string, unknown>}
        assert.equal(json.key, API_KEY)
        assert.ok(json.providers.p, 'response includes the provider')
    } finally {
        await s.close()
    }
})

test('POST /config returns 405', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/config`, {
            method: 'POST',
            headers: {authorization: `Bearer ${API_KEY}`},
        })
        assert.equal(res.status, 405)
        assert.equal(res.headers.get('allow'), 'PUT')
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'method_not_allowed')
    } finally {
        await s.close()
    }
})

test('PUT /config rejects an invalid body with 400', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/config`, {
            method: 'PUT',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: '{not valid json',
        })
        assert.equal(res.status, 400)
        const json = await res.json() as {error: {type: string}}
        assert.equal(json.error.type, 'invalid_request_error')
    } finally {
        await s.close()
    }
})

test('PUT /config rejects a config with no providers', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/config`, {
            method: 'PUT',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: JSON.stringify({providers: {}}),
        })
        assert.equal(res.status, 400)
        const json = await res.json() as {error: {message: string}}
        assert.match(json.error.message, /at least one provider/i)
    } finally {
        await s.close()
    }
})

test('PUT /config updates the running config', async () => {
    const s = await setup()
    try {
        const newConfig = {
            port: s.port,
            key: API_KEY,
            providers: {
                p: {base_url: 'http://127.0.0.1:1', api_key: 'bk', models: []},
                q: {base_url: 'http://127.0.0.1:2', api_key: 'qk', models: [{id: 'qm'}]},
            },
        }
        const res = await fetch(`http://127.0.0.1:${s.port}/config`, {
            method: 'PUT',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: JSON.stringify(newConfig),
        })
        assert.equal(res.status, 200)
        const json = await res.json() as {providers: Record<string, unknown>}
        assert.ok(json.providers.q, 'response includes the new provider')

        // The running server should route to the new provider: a request for
        // q/qm hits the (unreachable) q backend with a 502, proving the new
        // provider is in effect rather than the old "provider not configured" 404.
        const proxyRes = await fetch(`http://127.0.0.1:${s.port}/v1/chat/completions`, {
            method: 'POST',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: JSON.stringify({model: 'q/qm', messages: []}),
        })
        assert.equal(proxyRes.status, 502)
    } finally {
        await s.close()
    }
})

test('PUT /config applies a key change immediately for subsequent requests', async () => {
    const s = await setup()
    try {
        const newKey = 'sk-rotated'
        const res = await fetch(`http://127.0.0.1:${s.port}/config`, {
            method: 'PUT',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: JSON.stringify({
                port: s.port,
                key: newKey,
                providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'bk', models: []}},
            }),
        })
        assert.equal(res.status, 200)

        // The old key should no longer authenticate.
        const oldKeyRes = await fetch(`http://127.0.0.1:${s.port}/v1/models`, {
            headers: {authorization: `Bearer ${API_KEY}`},
        })
        assert.equal(oldKeyRes.status, 401)

        // The new key should be accepted (reaches the handler, which then tries
        // the unreachable backend and returns 200 from /v1/models fallback).
        const newKeyRes = await fetch(`http://127.0.0.1:${s.port}/v1/models`, {
            headers: {authorization: `Bearer ${newKey}`},
        })
        assert.equal(newKeyRes.status, 200)
    } finally {
        await s.close()
    }
})
