import {test} from 'node:test'
import assert from 'node:assert/strict'
import {dirname, join} from 'path'
import {loadConfig} from '../lib/config'
import {getFreePort, startCrServer, startMockBackend, writeTempConfig} from './helpers'

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

test('GET /config with accept json returns the running config without provider secrets', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/config`, {
            headers: {authorization: `Bearer ${API_KEY}`, accept: 'application/json'},
        })
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'application/json')
        const text = await res.text()
        const json = JSON.parse(text) as {port: number, key: string, db: string | false, retentionDays: number, providers: {p: Record<string, unknown>}}
        assert.equal(json.key, API_KEY)
        assert.equal(json.db, join(dirname(s.path), 'closerouter.db'), 'db exposes the resolved dbPath')
        assert.equal(json.retentionDays, 7)
        assert.ok(json.providers.p, 'response includes the provider')
        assert.ok(!('api_key' in json.providers.p), 'provider api_key is omitted')
        assert.ok(!text.includes('bk'), 'stored secrets do not appear in the response')
    } finally {
        await s.close()
    }
})

test('GET /config exposes db: false so it survives an editor round-trip', async () => {
    const port = await getFreePort()
    const {path, cleanup} = await writeTempConfig({
        port,
        key: API_KEY,
        db: false,
        providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'bk', models: []}},
    })
    const srv = await startCrServer(loadConfig(path))
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/config`, {
            headers: {authorization: `Bearer ${API_KEY}`, accept: 'application/json'},
        })
        const json = await res.json() as {db: string | false}
        assert.equal(json.db, false)
    } finally {
        await srv.close()
        await cleanup()
    }
})

test('PUT /config keeps stored provider secrets when the api_key is omitted or blank', async () => {
    const backend = await startMockBackend()
    const port = await getFreePort()
    const {path, cleanup} = await writeTempConfig({
        port,
        key: API_KEY,
        providers: {p: {base_url: backend.baseUrl, api_key: 'sk-stored-secret', models: []}},
    })
    const srv = await startCrServer(loadConfig(path))
    const put = (providers: Record<string, unknown>) => fetch(`http://127.0.0.1:${srv.port}/config`, {
        method: 'PUT',
        headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
        body: JSON.stringify({key: API_KEY, providers}),
    })
    const usedKey = async () => {
        await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {headers: {authorization: `Bearer ${API_KEY}`}})
        return backend.requests.at(-1)?.headers.authorization
    }
    try {
        // baseline: the stored secret reaches the upstream before any PUT
        assert.equal(await usedKey(), 'Bearer sk-stored-secret')

        // omitted api_key keeps the stored secret
        const omitted = await put({p: {base_url: backend.baseUrl, models: []}})
        assert.equal(omitted.status, 200)
        const text = await omitted.text()
        assert.ok(!text.includes('sk-stored-secret'), 'PUT response echoes no secrets')
        const json = JSON.parse(text) as {providers: {p: Record<string, unknown>}}
        assert.ok(!('api_key' in json.providers.p), 'PUT response omits api_key')
        assert.equal(await usedKey(), 'Bearer sk-stored-secret')

        // an explicitly blank api_key also keeps it
        const blanked = await put({p: {base_url: backend.baseUrl, api_key: '', models: []}})
        assert.equal(blanked.status, 200)
        assert.equal(await usedKey(), 'Bearer sk-stored-secret')

        // a typed api_key replaces it
        const rotated = await put({p: {base_url: backend.baseUrl, api_key: 'sk-rotated', models: []}})
        assert.equal(rotated.status, 200)
        assert.equal(await usedKey(), 'Bearer sk-rotated')
    } finally {
        await srv.close()
        await backend.close()
        await cleanup()
    }
})

test('PUT /config still requires an api_key for new providers', async () => {
    const s = await setup()
    try {
        const res = await fetch(`http://127.0.0.1:${s.port}/config`, {
            method: 'PUT',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: JSON.stringify({
                providers: {
                    p: {base_url: 'http://127.0.0.1:1', models: []}, // known: omitted key is preserved
                    q: {base_url: 'http://127.0.0.1:2', models: []}, // unknown: still needs a key
                },
            }),
        })
        assert.equal(res.status, 400)
        const json = await res.json() as {error: {message: string}}
        assert.match(json.error.message, /api_key/)
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
        assert.match(json.error.message, /providers.*at least 1 property/i)
    } finally {
        await s.close()
    }
})

test('PUT /config updates live fields but leaves retention unchanged until restart', async () => {
    const s = await setup()
    try {
        const newConfig = {
            port: s.port,
            key: API_KEY,
            retentionDays: 30,
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
        const json = await res.json() as {retentionDays: number, providers: Record<string, unknown>}
        assert.equal(json.retentionDays, 30)
        assert.ok(json.providers.q, 'response includes the new provider')

        const runningRes = await fetch(`http://127.0.0.1:${s.port}/config`, {
            headers: {authorization: `Bearer ${API_KEY}`, accept: 'application/json'},
        })
        const running = await runningRes.json() as {retentionDays: number}
        assert.equal(running.retentionDays, 7)

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
