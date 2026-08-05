import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resolve} from 'path'
import {loadConfig, resolveConfigPath} from '../lib/config'
import {captureExit, writeTempConfig, writeTempFile} from './helpers'

test('resolveConfigPath defaults to closerouter.json in cwd', () => {
    const orig = process.argv
    process.argv = ['node', 'cli']
    try {
        assert.equal(resolveConfigPath(), resolve(process.cwd(), 'closerouter.json'))
    } finally {
        process.argv = orig
    }
})

test('resolveConfigPath uses argv[2] when provided', () => {
    const orig = process.argv
    process.argv = ['node', 'cli', '/custom/path.json']
    try {
        assert.equal(resolveConfigPath(), resolve(process.cwd(), '/custom/path.json'))
    } finally {
        process.argv = orig
    }
})

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
