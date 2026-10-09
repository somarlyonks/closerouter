import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {RuntimeConfig} from '../lib/config'
import {listModelsHandler, normalizeModel} from '../lib/server/v1/models'
import {createModelsCache} from '../lib/server/helper'
import {delay, startMockBackend, startHandlerServer} from './helpers'

test('listModelsHandler fetches and normalizes models from each provider', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({data: [{id: 'm1'}, {id: 'm2', owned_by: 'vendor'}]}))
    })
    const config: RuntimeConfig = {
        dbPath: '', port: 6712, key: 'k', retentionDays: 7,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: []}},
    }
    const srv = await startHandlerServer(listModelsHandler(), {config})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {
            headers: {authorization: 'Bearer k'},
        })
        assert.equal(res.status, 200)
        assert.equal(res.headers.get('content-type'), 'application/json')
        const json = await res.json() as {object: string, data: unknown[]}
        assert.equal(json.object, 'list')
        assert.deepEqual(json.data, [
            {id: 'p/m1', owned_by: 'p'},
            {id: 'p/m2', owned_by: 'vendor'},
        ])
        assert.equal(backend.requests[0].url, '/models')
        assert.equal(backend.requests[0].headers.authorization, 'Bearer bk')
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('listModelsHandler falls back to config models when the backend returns a non-200', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(500)
        res.end('err')
    })
    const config: RuntimeConfig = {
        dbPath: '', port: 6712, key: 'k', retentionDays: 7,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: ['fallback-a', {id: 'fallback-b'}]}},
    }
    const srv = await startHandlerServer(listModelsHandler(), {config})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {
            headers: {authorization: 'Bearer k'},
        })
        assert.equal(res.status, 200)
        const json = await res.json() as {data: unknown[]}
        assert.deepEqual(json.data, [
            {id: 'p/fallback-a'},
            {id: 'p/fallback-b', owned_by: 'p'},
        ])
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('listModelsHandler falls back to config models when the backend response is malformed', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({notdata: 1}))
    })
    const config: RuntimeConfig = {
        dbPath: '', port: 6712, key: 'k', retentionDays: 7,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: [{id: 'cfg-model'}]}},
    }
    const srv = await startHandlerServer(listModelsHandler(), {config})
    try {
        const res = await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {
            headers: {authorization: 'Bearer k'},
        })
        assert.equal(res.status, 200)
        const json = await res.json() as {data: unknown[]}
        assert.deepEqual(json.data, [{id: 'p/cfg-model', owned_by: 'p'}])
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('listModelsHandler bounds a stalled provider with a short timeout and falls back to config models', async () => {
    const backend = await startMockBackend(() => {
        // Hold the request open: only the idle deadline can settle it.
    })
    const config: RuntimeConfig = {
        dbPath: '', port: 6712, key: 'k', retentionDays: 7,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: ['fallback']}},
    }
    const srv = await startHandlerServer(
        listModelsHandler(150),
        {config},
    )
    try {
        const start = Date.now()
        const res = await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {
            headers: {authorization: 'Bearer k'},
        })
        const elapsed = Date.now() - start
        assert.equal(res.status, 200)
        const json = await res.json() as {data: unknown[]}
        assert.deepEqual(json.data, [{id: 'p/fallback'}])
        // The 150ms deadline - not the 180s generation idle timeout - settles it.
        assert.ok(elapsed < 1000, `responded in ${elapsed}ms, expected under 1s`)
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('listModelsHandler serves a fresh cache without re-fetching providers', async () => {
    let hits = 0
    const backend = await startMockBackend((_req, res) => {
        hits += 1
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({data: [{id: `m${hits}`}]}))
    })
    const config: RuntimeConfig = {
        dbPath: '', port: 6712, key: 'k', retentionDays: 7,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: []}},
    }
    const srv = await startHandlerServer(listModelsHandler(), {config, modelsCache: createModelsCache()})
    try {
        for (let i = 0; i < 2; i += 1) {
            const res = await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {
                headers: {authorization: 'Bearer k'},
            })
            assert.equal(res.status, 200)
            const json = await res.json() as {data: unknown[]}
            assert.deepEqual(json.data, [{id: 'p/m1', owned_by: 'p'}])
        }
        assert.equal(hits, 1)
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('listModelsHandler serves a stale cache immediately and refreshes in the background', async () => {
    let hits = 0
    const backend = await startMockBackend((_req, res) => {
        hits += 1
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({data: [{id: `m${hits}`}]}))
    })
    const config: RuntimeConfig = {
        dbPath: '', port: 6712, key: 'k', retentionDays: 7,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: []}},
    }
    const srv = await startHandlerServer(listModelsHandler(), {config, modelsCache: createModelsCache(200)})
    try {
        const first = await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {
            headers: {authorization: 'Bearer k'},
        })
        assert.deepEqual((await first.json() as {data: unknown[]}).data, [{id: 'p/m1', owned_by: 'p'}])
        assert.equal(hits, 1)

        await delay(250) // past the 200ms TTL

        const stale = await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {
            headers: {authorization: 'Bearer k'},
        })
        // the stale list is served immediately, not waited on
        assert.deepEqual((await stale.json() as {data: unknown[]}).data, [{id: 'p/m1', owned_by: 'p'}])

        // the background refresh lands shortly after
        await delay(100)
        assert.equal(hits, 2)

        const fresh = await fetch(`http://127.0.0.1:${srv.port}/v1/models`, {
            headers: {authorization: 'Bearer k'},
        })
        assert.deepEqual((await fresh.json() as {data: unknown[]}).data, [{id: 'p/m2', owned_by: 'p'}])
    } finally {
        await srv.close()
        await backend.close()
    }
})

test('createModelsCache coalesces concurrent refreshes and expires past the TTL', async () => {
    const cache = createModelsCache(20)
    assert.equal(cache.get(), undefined)
    assert.equal(cache.isStale(), true)

    let calls = 0
    const fetcher = async (): Promise<unknown[]> => {
        calls += 1
        await delay(5)
        return [{id: `m${calls}`}]
    }

    const [a, b] = await Promise.all([cache.refresh(fetcher), cache.refresh(fetcher)])
    assert.equal(calls, 1)
    assert.deepEqual(a, [{id: 'm1'}])
    assert.deepEqual(b, [{id: 'm1'}])
    assert.equal(cache.isStale(), false)

    await delay(40)
    assert.equal(cache.isStale(), true)
    assert.deepEqual(cache.get(), [{id: 'm1'}]) // stale data is still served

    await cache.refresh(fetcher)
    assert.equal(calls, 2)
    assert.deepEqual(cache.get(), [{id: 'm2'}])
})

test('normalizeModel wraps a string model as {id: "provider/model"}', () => {
    assert.deepEqual(normalizeModel('p', 'gpt'), {id: 'p/gpt'})
})

test('normalizeModel prefixes an object model id and defaults owned_by', () => {
    assert.deepEqual(normalizeModel('p', {id: 'm'}), {id: 'p/m', owned_by: 'p'})
})

test('normalizeModel preserves an explicit owned_by', () => {
    assert.deepEqual(normalizeModel('p', {id: 'm', owned_by: 'vendor'}), {id: 'p/m', owned_by: 'vendor'})
})

test('normalizeModel throws when model object has no id', () => {
    assert.throws(() => normalizeModel('p', {}), /Model config broken/)
    assert.throws(() => normalizeModel('p', undefined), /Model config broken/)
    assert.throws(() => normalizeModel('p', 5), /Model config broken/)
})
