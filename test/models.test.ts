import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {Config} from '../lib/config'
import {handleListModels} from '../lib/server/v1/models'
import {startMockBackend, startHandlerServer} from './helpers'

test('handleListModels fetches and normalizes models from each provider', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({data: [{id: 'm1'}, {id: 'm2', owned_by: 'vendor'}]}))
    })
    const config: Config = {
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: []}},
    }
    const srv = await startHandlerServer(handleListModels, {config, apiKey: 'k'})
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

test('handleListModels falls back to config models when the backend returns a non-200', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(500)
        res.end('err')
    })
    const config: Config = {
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: ['fallback-a', {id: 'fallback-b'}]}},
    }
    const srv = await startHandlerServer(handleListModels, {config, apiKey: 'k'})
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

test('handleListModels falls back to config models when the backend response is malformed', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({notdata: 1}))
    })
    const config: Config = {
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: [{id: 'cfg-model'}]}},
    }
    const srv = await startHandlerServer(handleListModels, {config, apiKey: 'k'})
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
