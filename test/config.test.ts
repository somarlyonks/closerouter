import {test} from 'node:test'
import assert from 'node:assert/strict'
import {dirname, resolve, join} from 'node:path'
import {loadConfig} from '../lib/config'
import {captureExit, writeTempConfig, writeTempFile} from './helpers'

test('loadConfig returns config with default port when omitted', async () => {
    const {path, cleanup} = await writeTempConfig({
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    try {
        const cfg = loadConfig(path)
        assert.equal(cfg.port, 6712)
        assert.equal(cfg.providers.p.base_url, 'http://x')
        assert.equal(cfg.providers.p.api_key, 'k')
    } finally {
        await cleanup()
    }
})

test('loadConfig preserves explicit port and key', async () => {
    const {path, cleanup} = await writeTempConfig({
        port: 8080,
        key: 'sk-x',
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    try {
        const cfg = loadConfig(path)
        assert.equal(cfg.port, 8080)
        assert.equal(cfg.key, 'sk-x')
    } finally {
        await cleanup()
    }
})

test('loadConfig exits when the config file is missing', () => {
    const res = captureExit(() => loadConfig('/no/such/closerouter.json'))
    assert.equal(res.exit?.code, 1)
    assert.match(res.stderr, /not found/i)
})

test('loadConfig exits on invalid JSON', async () => {
    const {path, cleanup} = await writeTempFile('{not valid json')
    try {
        const res = captureExit(() => loadConfig(path))
        assert.equal(res.exit?.code, 1)
        assert.match(res.stderr, /invalid json/i)
    } finally {
        await cleanup()
    }
})

test('loadConfig exits when port is out of range', async () => {
    const {path, cleanup} = await writeTempConfig({
        port: 99999,
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    try {
        const res = captureExit(() => loadConfig(path))
        assert.equal(res.exit?.code, 1)
        assert.match(res.stderr, /port/i)
    } finally {
        await cleanup()
    }
})

test('loadConfig exits when port is not a number', async () => {
    const {path, cleanup} = await writeTempConfig({
        port: '8080',
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    try {
        const res = captureExit(() => loadConfig(path))
        assert.equal(res.exit?.code, 1)
        assert.match(res.stderr, /port/i)
    } finally {
        await cleanup()
    }
})

test('loadConfig exits when providers is not an object', async () => {
    const {path, cleanup} = await writeTempConfig({providers: 'nope'})
    try {
        const res = captureExit(() => loadConfig(path))
        assert.equal(res.exit?.code, 1)
        assert.match(res.stderr, /providers/i)
    } finally {
        await cleanup()
    }
})

test('loadConfig exits when providers is empty', async () => {
    const {path, cleanup} = await writeTempConfig({providers: {}})
    try {
        const res = captureExit(() => loadConfig(path))
        assert.equal(res.exit?.code, 1)
        assert.match(res.stderr, /at least one provider/i)
    } finally {
        await cleanup()
    }
})

test('loadConfig exits when a provider is missing base_url', async () => {
    const {path, cleanup} = await writeTempConfig({
        providers: {p: {api_key: 'k'}},
    })
    try {
        const res = captureExit(() => loadConfig(path))
        assert.equal(res.exit?.code, 1)
        assert.match(res.stderr, /base_url/)
    } finally {
        await cleanup()
    }
})

test('loadConfig exits when a provider is missing api_key', async () => {
    const {path, cleanup} = await writeTempConfig({
        providers: {p: {base_url: 'http://x'}},
    })
    try {
        const res = captureExit(() => loadConfig(path))
        assert.equal(res.exit?.code, 1)
        assert.match(res.stderr, /api_key/)
    } finally {
        await cleanup()
    }
})

test('loadConfig defaults dbPath to in memory next to the config', async () => {
    const {path, cleanup} = await writeTempConfig({
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    try {
        const cfg = loadConfig(path)
        assert.equal(cfg.dbPath, '')
    } finally {
        await cleanup()
    }
})

test('loadConfig resolves a relative db path against the config directory', async () => {
    const {path, cleanup} = await writeTempConfig({
        db: 'data/usage.db',
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    try {
        const cfg = loadConfig(path)
        assert.equal(cfg.dbPath, join(dirname(path), 'data', 'usage.db'))
    } finally {
        await cleanup()
    }
})

test('loadConfig keeps an absolute db path and "" means in-memory', async () => {
    const abs = resolve('/tmp', 'abs.db')
    const withAbs = await writeTempConfig({
        db: abs,
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    const withMemory = await writeTempConfig({
        db: '',
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    try {
        assert.equal(loadConfig(withAbs.path).dbPath, abs)
        assert.equal(loadConfig(withMemory.path).dbPath, '')
    } finally {
        await withAbs.cleanup()
        await withMemory.cleanup()
    }
})

test('loadConfig disables storage for db: false', async () => {
    const {path, cleanup} = await writeTempConfig({
        db: false,
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    try {
        assert.equal(loadConfig(path).dbPath, undefined)
    } finally {
        await cleanup()
    }
})

test('loadConfig exits when db has an invalid type', async () => {
    const {path, cleanup} = await writeTempConfig({
        db: 42,
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    try {
        const res = captureExit(() => loadConfig(path))
        assert.equal(res.exit?.code, 1)
        assert.match(res.stderr, /db/i)
    } finally {
        await cleanup()
    }
})
