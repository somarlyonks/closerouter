import {test} from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'events'
import type {RuntimeConfig} from '../lib/config'
import {startServer} from '../lib/server'
import {startMockBackend, getFreePort} from './helpers'

const KEY = 'sk-matrix'

/** Freeze the routing behavior of the whole server: one matrix of
 *  method x path (with near-misses) asserting the status and allow header. */
test('routing matrix: method x path dispatch is frozen', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({id: 'x', choices: []}))
    })
    const port = await getFreePort()
    const config: RuntimeConfig = {
        dbPath: ':memory:',
        retentionDays: 7,
        port,
        key: KEY,
        providers: {p: {base_url: backend.baseUrl, api_key: 'bk', models: ['m']}},
    }
    const server = startServer(config)
    await once(server, 'listening')

    const auth = {authorization: `Bearer ${KEY}`}
    const json = {...auth, 'accept': 'application/json', 'content-type': 'application/json'}
    interface MatrixCase {
        method: string
        path: string
        headers?: Record<string, string>
        body?: string
        status: number
        allow?: string
    }
    const cases: Array<MatrixCase> = [
        // OPTIONS is a global CORS pre-gate answering for any path
        {method: 'OPTIONS', path: '/status', status: 204},
        {method: 'OPTIONS', path: '/nope', status: 204},
        // /status: no auth
        {method: 'GET', path: '/status', status: 200},
        {method: 'POST', path: '/status', status: 405, allow: 'GET'},
        {method: 'DELETE', path: '/status', status: 405, allow: 'GET'},
        // /logs: HTML without auth, JSON with auth; method before auth
        {method: 'GET', path: '/logs', headers: {accept: 'text/html'}, status: 200},
        {method: 'GET', path: '/logs', headers: json, status: 200},
        {method: 'GET', path: '/logs', headers: {accept: 'application/json'}, status: 401},
        {method: 'POST', path: '/logs', status: 405, allow: 'GET'},
        // /logs/:id: numeric ids are details, others fall to 404
        {method: 'GET', path: '/logs/1', headers: auth, status: 404},
        {method: 'GET', path: '/logs/abc', headers: auth, status: 404},
        {method: 'GET', path: '/logs/1', status: 401},
        {method: 'DELETE', path: '/logs/1', headers: auth, status: 405, allow: 'GET'},
        // /usage: exact pathname, all variation is in query params, auth required
        {method: 'GET', path: '/usage', headers: auth, status: 200},
        {method: 'GET', path: '/usagefoo', headers: auth, status: 404},
        {method: 'GET', path: '/usage/1', headers: auth, status: 404},
        {method: 'GET', path: '/usage', status: 401},
        {method: 'POST', path: '/usage', status: 405, allow: 'GET'},
        {method: 'POST', path: '/usage', headers: auth, status: 405, allow: 'GET'},
        // /v1: auth precedes method checks; /models is GET-only while other
        // paths are proxied only for POST requests
        {method: 'GET', path: '/v1/models', headers: auth, status: 200},
        {method: 'GET', path: '/v1/models', status: 401},
        {method: 'POST', path: '/v1/models', headers: json, body: JSON.stringify({model: 'p/m'}), status: 405, allow: 'GET'},
        {method: 'GET', path: '/v1/chat/completions', headers: auth, status: 405, allow: 'POST'},
        {method: 'DELETE', path: '/v1/models', headers: auth, status: 405, allow: 'GET'},
        {method: 'DELETE', path: '/v1/models', status: 401},
        {method: 'POST', path: '/v1/chat/completions', headers: json, body: JSON.stringify({model: 'p/m'}), status: 200},
        {method: 'POST', path: '/v1/chat/completions', status: 401},
        // /v1 without a trailing slash, or with a different prefix, is a 404
        {method: 'POST', path: '/v1', headers: json, body: JSON.stringify({model: 'p/m'}), status: 404},
        {method: 'GET', path: '/v1foo', headers: auth, status: 404},
        // /config: HTML without auth, JSON GET with auth, PUT with auth
        {method: 'GET', path: '/config', status: 200},
        {method: 'GET', path: '/config', headers: json, status: 200},
        {method: 'GET', path: '/config', headers: {accept: 'application/json'}, status: 401},
        {
            method: 'PUT', path: '/config',
            headers: {...auth, 'content-type': 'application/json'},
            body: JSON.stringify({key: KEY, providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'bk'}}}),
            status: 200,
        },
        {method: 'PUT', path: '/config', status: 401},
        {method: 'POST', path: '/config', status: 405, allow: 'GET, PUT'},
        {method: 'POST', path: '/config', headers: auth, status: 405, allow: 'GET, PUT'},
        // nothing matches
        {method: 'GET', path: '/nope', status: 404},
        {method: 'POST', path: '/nope', status: 404},
        // query strings are ignored by path matching
        {method: 'GET', path: '/status?x=1', status: 200},
        {method: 'GET', path: '/v1/models?x=1', headers: auth, status: 200},
    ]

    try {
        for (const c of cases) {
            const res = await fetch(`http://127.0.0.1:${port}${c.path}`, {
                method: c.method,
                headers: c.headers,
                body: c.body,
            })
            const label = `${c.method} ${c.path}`
            assert.equal(res.status, c.status, label)
            if (c.allow !== undefined) assert.equal(res.headers.get('allow'), c.allow, label)
            await res.arrayBuffer() // drain
        }
    } finally {
        server.close()
        await backend.close()
    }
})
