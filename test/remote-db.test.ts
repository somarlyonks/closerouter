// Remote usage db: `db: "upstream:<url>#<key>"` stores usage through another
// closerouter's usage API. The instance keeps no local sqlite, aliases rows
// before posting them, and forwards usage reads to that owner.

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {displayDbPath, loadConfig, parseConfig, parseRemoteDb, printServerConfig, resolveDbPath, type RuntimeConfig} from '../lib/config'
import {createUpstreamTracker} from '../lib/server/helper'
import {recordUsageEntry} from '../lib/server/logs/helper'
import type {UsageEntry} from '../lib/server/logs/db'
import {captureExit, delay, getFreePort, startCrServer, startMockBackend, stubConsoleError, writeTempConfig} from './helpers'

const OWNER_KEY = 'sk-owner'
const API_KEY = 'sk-api'

function remoteConfig (dbPath: string, over: Partial<RuntimeConfig> = {}): RuntimeConfig {
    return {
        port: 6712,
        key: API_KEY,
        dbPath,
        retentionDays: 7,
        alias: {},
        providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'pk', models: [{id: 'm'}]}},
        ...over,
    }
}

function document (db: unknown, over: Record<string, unknown> = {}): string {
    return JSON.stringify({db, providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'k'}}, ...over})
}

const sampleEntry = (): UsageEntry => ({
    requestId: 'req-1',
    time: 1_700_000_000_000,
    method: 'POST',
    path: '/v1/chat/completions',
    provider: 'p',
    model: 'm',
    inputTokens: 3,
})

async function waitFor (predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('condition was not met in time')
        await delay(10)
    }
}

test('a posting row stays tracked until the owner answers', async () => {
    const holder: {answer?: () => void} = {}
    const owner = await startMockBackend((_req, res) => {
        holder.answer = () => {
            res.writeHead(201, {'content-type': 'application/json'})
            res.end('{"ok":true}')
        }
    })
    const upstream = createUpstreamTracker()
    const errors = stubConsoleError()
    try {
        recordUsageEntry(sampleEntry(), remoteConfig(`upstream:${owner.baseUrl}#${OWNER_KEY}`), upstream)
        await waitFor(() => owner.requests.length === 1)
        assert.equal(upstream.size(), 1, 'the row counts as in flight until the owner answers')

        holder.answer!()
        await waitFor(() => upstream.size() === 0)
    } finally {
        errors.restore()
        await owner.close()
    }
    assert.equal(errors.errors.length, 0, 'a row the owner accepted is not a failure')
})

test('a row still in flight at the drain deadline is aborted and logged', async () => {
    const owner = await startMockBackend(() => {}) // reads the row, never answers
    const upstream = createUpstreamTracker()
    const errors = stubConsoleError()
    try {
        recordUsageEntry(sampleEntry(), remoteConfig(`upstream:${owner.baseUrl}#${OWNER_KEY}`), upstream)
        await waitFor(() => owner.requests.length === 1)
        assert.equal(upstream.size(), 1)

        upstream.abortAll()
        assert.equal(upstream.size(), 0, 'an aborted row stops blocking the drain')
        await waitFor(() => errors.errors.length > 0)
    } finally {
        errors.restore()
        await owner.close()
    }
    assert.ok(
        errors.errors.some(args => String(args[0]).includes('req-1') && String(args[0]).includes('aborted')),
        'a row dropped at the drain deadline is logged with its request id',
    )
})

test('db accepts the remote usage syntax and keeps no local path', () => {
    const config = parseConfig(document('upstream:https://usage.example.com:6712#sk-owner'))
    assert.equal(config.dbPath, 'upstream:https://usage.example.com:6712#sk-owner')
    assert.deepEqual(parseRemoteDb(config.dbPath), {url: 'https://usage.example.com:6712', key: 'sk-owner'})
    assert.equal(displayDbPath(config.dbPath), 'upstream:https://usage.example.com:6712')
    assert.equal(parseRemoteDb('usage.db'), undefined)
})

test('db keeps a local path and false working', () => {
    const local = parseConfig(document('usage.db'))
    assert.equal(local.dbPath, 'usage.db')
    assert.equal(displayDbPath(local.dbPath), 'usage.db')

    const disabled = parseConfig(document(false))
    assert.equal(disabled.dbPath, undefined)
    assert.equal(displayDbPath(disabled.dbPath), undefined)
})

test('db rejects malformed remote usage targets', () => {
    const cases = [
        'upstream:http://127.0.0.1:6712',
        'upstream:http://127.0.0.1:6712#',
        'upstream:#sk-owner',
        'upstream:ftp://127.0.0.1#sk-owner',
        'upstream:not a url#sk-owner',
        'upstream:http://127.0.0.1:6712/logs?limit=1#sk-owner',
        'upstream:http://user:pw@127.0.0.1:6712#sk-owner',
    ]
    for (const db of cases) {
        assert.throws(() => parseConfig(document(db)), /db:/, db)
    }
})

test('loadConfig keeps the remote db string verbatim without path resolution', async () => {
    const port = await getFreePort()
    const db = `upstream:http://127.0.0.1:6712#${OWNER_KEY}`
    const {path, cleanup} = await writeTempConfig({
        port,
        key: API_KEY,
        db,
        providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'pk'}},
    })
    try {
        const config = loadConfig(path)
        assert.equal(config.dbPath, db)
        assert.equal(resolveDbPath(config.dbPath, path), db, 'a remote target is not resolved against the config directory')
    } finally {
        await cleanup()
    }
})

test('recording posts the row to the remote db with its key and the writer alias', async () => {
    const owner = await startMockBackend()
    try {
        const errors = stubConsoleError()
        try {
            recordUsageEntry(sampleEntry(), remoteConfig(`upstream:${owner.baseUrl}#${OWNER_KEY}`, {
                alias: {'p/m': 'canonical-m'},
            }))
            await delay(100)
        } finally {
            errors.restore()
        }

        assert.equal(owner.requests.length, 1)
        assert.equal(owner.requests[0].method, 'POST')
        assert.equal(owner.requests[0].url, '/logs')
        assert.equal(owner.requests[0].headers.authorization, `Bearer ${OWNER_KEY}`)
        const row = JSON.parse(owner.requests[0].body) as Record<string, unknown>
        assert.equal(row.requestId, 'req-1')
        assert.equal(row.provider, 'p')
        assert.equal(row.model, 'canonical-m', 'the recording instance applies its own alias map')
    } finally {
        await owner.close()
    }
})

test('the banner never prints the storage target or the remote key', () => {
    const remote = captureExit(() => printServerConfig(remoteConfig(`upstream:http://127.0.0.1:6712#${OWNER_KEY}`)))
    assert.doesNotMatch(remote.stdout, /Usage log/i)
    assert.doesNotMatch(remote.stdout, new RegExp(OWNER_KEY))

    const local = captureExit(() => printServerConfig(remoteConfig('usage.db')))
    assert.doesNotMatch(local.stdout, /usage\.db/)

    const disabled = captureExit(() => printServerConfig({...remoteConfig('usage.db'), dbPath: undefined}))
    assert.doesNotMatch(disabled.stdout, /Usage log/i)
})

test('an unreachable remote db never blocks a proxied request', async () => {
    const backend = await startMockBackend((_req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({id: 'chatcmpl-1', choices: []}))
    })
    const port = await getFreePort()
    const config = remoteConfig(`upstream:http://127.0.0.1:1#${OWNER_KEY}`, {
        port,
        providers: {p: {base_url: backend.baseUrl, api_key: 'pk', models: [{id: 'm'}]}},
    })
    const errors = stubConsoleError()
    const server = await startCrServer(config)
    try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: JSON.stringify({model: 'p/m', messages: []}),
        })
        assert.equal(res.status, 200)
        await res.text()
        assert.equal(backend.requests.length, 1, 'the provider call is unaffected by the dead db')
    } finally {
        await server.close()
        await backend.close()
        errors.restore()
    }
})

test('usage reads are forwarded to the remote db and the page stays local', async () => {
    const owner = await startMockBackend((req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(req.url?.startsWith('/logs/7')
            ? JSON.stringify({requestBody: 'q', responseBody: 'a'})
            : JSON.stringify({entries: [{id: 7}], total: 1}))
    })
    const port = await getFreePort()
    const server = await startCrServer(remoteConfig(`upstream:${owner.baseUrl}#${OWNER_KEY}`, {port}))
    const auth = {authorization: `Bearer ${API_KEY}`}
    try {
        const page = await fetch(`http://127.0.0.1:${port}/logs?limit=2`, {
            headers: {...auth, accept: 'application/json'},
        })
        assert.equal(page.status, 200)
        assert.equal((await page.json() as {total: number}).total, 1)

        const detail = await fetch(`http://127.0.0.1:${port}/logs/7`, {
            headers: {...auth, accept: 'application/json'},
        })
        assert.equal(detail.status, 200)
        assert.deepEqual(await detail.json(), {requestBody: 'q', responseBody: 'a'})

        const usage = await fetch(`http://127.0.0.1:${port}/usage`, {headers: auth})
        assert.equal(usage.status, 200)

        const html = await fetch(`http://127.0.0.1:${port}/logs`)
        assert.equal(html.status, 200)
        assert.match(html.headers.get('content-type') ?? '', /text\/html/)

        assert.deepEqual(owner.requests.map(r => r.url), ['/logs?limit=2', '/logs/7', '/usage'])
        assert.equal(owner.requests[0].headers.authorization, `Bearer ${OWNER_KEY}`)
    } finally {
        await server.close()
        await owner.close()
    }
})

test('GET /config reports the remote db without its key', async () => {
    const port = await getFreePort()
    const {path, cleanup} = await writeTempConfig({
        port,
        key: API_KEY,
        db: `upstream:http://127.0.0.1:6712#${OWNER_KEY}`,
        providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'pk'}},
    })
    const server = await startCrServer(loadConfig(path))
    try {
        const res = await fetch(`http://127.0.0.1:${port}/config`, {
            headers: {authorization: `Bearer ${API_KEY}`, accept: 'application/json'},
        })
        assert.equal(res.status, 200)
        const raw = await res.text()
        assert.match(raw, /"db": "upstream:http:\/\/127\.0\.0\.1:6712"/)
        assert.doesNotMatch(raw, new RegExp(OWNER_KEY))
        assert.doesNotMatch(raw, /restartRequired/, 'only the PUT echo names boot-only changes')
    } finally {
        await server.close()
        await cleanup()
    }
})

test('PUT /config reports a rotated remote key as a db change, without printing it', async () => {
    const port = await getFreePort()
    const {path, cleanup} = await writeTempConfig({
        port,
        key: API_KEY,
        db: `upstream:http://127.0.0.1:6712#${OWNER_KEY}`,
        providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'pk'}},
    })
    const server = await startCrServer(loadConfig(path))
    const logs: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => {
        logs.push(args.join(' '))
    }
    try {
        const res = await fetch(`http://127.0.0.1:${port}/config`, {
            method: 'PUT',
            headers: {'authorization': `Bearer ${API_KEY}`, 'content-type': 'application/json'},
            body: JSON.stringify({
                port,
                key: API_KEY,
                db: 'upstream:http://127.0.0.1:6712#rotated-key',
                providers: {p: {base_url: 'http://127.0.0.1:1', api_key: 'pk'}},
            }),
        })
        assert.equal(res.status, 200)
        const echoed = await res.json() as {db?: string, restartRequired?: string[]}
        assert.deepEqual(echoed.restartRequired, ['db'], 'a rotated owner key is a db change the supervisor must act on')
        assert.equal(echoed.db, 'upstream:http://127.0.0.1:6712')
    } finally {
        console.log = origLog
        await server.close()
        await cleanup()
    }

    const changed = logs.find(l => l.includes('config db changed'))
    assert.ok(changed, 'a rotated owner key needs a restart to take effect')
    assert.ok(changed.includes('restart'))
    assert.doesNotMatch(changed, /rotated-key/)
})

test('status reports a remote usage db', async () => {
    const port = await getFreePort()
    const server = await startCrServer(remoteConfig(`upstream:http://127.0.0.1:6712#${OWNER_KEY}`, {port}))
    try {
        const res = await fetch(`http://127.0.0.1:${port}/status`)
        const json = await res.json() as {sqlite?: string, upstream?: string}
        assert.equal(json.sqlite, 'remote')
        assert.equal(json.upstream, undefined)
    } finally {
        await server.close()
    }
})
