import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'child_process'
import {mkdtemp, writeFile, rm} from 'fs/promises'
import {tmpdir} from 'os'
import {dirname, join, resolve} from 'path'
import {fileURLToPath} from 'url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loader = join(repoRoot, 'test', 'loader.mjs')
const cli = join(repoRoot, 'lib', 'cli.ts')

interface TestResult {
    status: number | null
    stdout: string
    stderr: string
}

function runTestCommand (args: string[], cwd?: string, input?: string): TestResult {
    const res = spawnSync(process.execPath, ['--import', loader, cli, ...args], {
        encoding: 'utf-8',
        cwd: cwd ?? repoRoot,
        input,
    })
    return {status: res.status, stdout: res.stdout, stderr: res.stderr}
}

test('test command accepts a valid config string silently', () => {
    const res = runTestCommand(['test', '{"providers": {"mock": {"base_url": "http://127.0.0.1:1", "api_key": "k", "models": ["m1"]}}}'])
    assert.equal(res.status, 0, res.stderr)
    assert.equal(res.stdout, '')
    assert.equal(res.stderr, '')
})

test('test command accepts a valid config from stdin silently', () => {
    const raw = JSON.stringify({providers: {mock: {base_url: 'http://127.0.0.1:1', api_key: 'k'}}})
    const res = runTestCommand(['test', '--stdin'], undefined, raw)
    assert.equal(res.status, 0, res.stderr)
    assert.equal(res.stdout, '')
    assert.equal(res.stderr, '')
})

test('test command accepts a config larger than the process argument limit from stdin', () => {
    const raw = JSON.stringify({
        providers: {mock: {base_url: 'http://127.0.0.1:1', api_key: 'k', models: ['m'.repeat(1_100_000)]}},
    })
    const res = runTestCommand(['test', '--stdin'], undefined, raw)
    assert.equal(res.status, 0, res.stderr)
})

test('test command reports schema issues for an invalid config from stdin', () => {
    const res = runTestCommand(['test', '--stdin'], undefined, '{"port": 0}')
    assert.equal(res.status, 1)
    assert.match(res.stderr, /"port" must be a number between 1 and 65535/)
})

test('test command rejects --stdin combined with a config argument', () => {
    const res = runTestCommand(['test', '--stdin', '{}'], undefined, '{}')
    assert.equal(res.status, 1)
    assert.match(res.stderr, /cannot test multiple inputs/i)
})

test('--stdin is rejected outside the test command', () => {
    const res = runTestCommand(['version', '--stdin'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /only supported by the test command/i)
})

test('test command reports schema issues for an invalid config string', () => {
    const res = runTestCommand(['test', '{"port": 99999, "providers": {"x": {"base_url": "nope"}}}'])
    assert.equal(res.status, 1)
    assert.equal(res.stdout, '')
    assert.match(res.stderr, /"port" must be a number between 1 and 65535/)
    assert.match(res.stderr, /"providers.x.api_key" is required but missing/)
    assert.match(res.stderr, /"providers.x.base_url" must be a valid URI/)
})

test('test command reports invalid JSON', () => {
    const res = runTestCommand(['test', '{not json'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /invalid json/i)
})

test('test command reports non-object roots', () => {
    const res = runTestCommand(['test', '[1, 2]'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /must be an object/)
})

test('test command accepts a valid config file via -c', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-cli-'))
    try {
        const configPath = join(dir, 'closerouter.json')
        await writeFile(configPath, JSON.stringify({
            port: 6790,
            db: 'data/usage.db',
            providers: {p: {base_url: 'http://x', api_key: 'secret-key'}},
        }))
        const res = runTestCommand(['test', '-c', configPath])
        assert.equal(res.status, 0, res.stderr)
        assert.equal(res.stdout, '')
    } finally {
        await rm(dir, {recursive: true, force: true})
    }
})

test('test command falls back to the default config file without arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-cli-'))
    try {
        // No closerouter.json in the empty cwd: the default config is missing.
        const missing = runTestCommand(['test'], dir)
        assert.equal(missing.status, 1)
        assert.match(missing.stderr, /not found/i)

        // With a default-named file present, it is tested.
        await writeFile(join(dir, 'closerouter.json'), '{"providers": {"p": {"base_url": "http://x", "api_key": "k"}}}')
        const present = runTestCommand(['test'], dir)
        assert.equal(present.status, 0, present.stderr)
        assert.equal(present.stdout, '')
    } finally {
        await rm(dir, {recursive: true, force: true})
    }
})

test('test command rejects a config string combined with -c', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cr-cli-'))
    try {
        const configPath = join(dir, 'closerouter.json')
        await writeFile(configPath, '{"providers": {"p": {"base_url": "http://x", "api_key": "k"}}}')
        const res = runTestCommand(['test', '-c', configPath, '{"port": 0}'])
        assert.equal(res.status, 1)
        assert.match(res.stderr, /cannot test multiple inputs/i)
    } finally {
        await rm(dir, {recursive: true, force: true})
    }
})

test('test command rejects --stdin combined with -c instead of ignoring the file', () => {
    const raw = JSON.stringify({providers: {p: {base_url: 'http://x', api_key: 'k'}}})
    const res = runTestCommand(['test', '--stdin', '-c', '/no/such/closerouter.json'], undefined, raw)
    assert.equal(res.status, 1)
    assert.match(res.stderr, /cannot test multiple inputs/i)
})

test('test command rejects surplus positional arguments', () => {
    const valid = '{"providers": {"p": {"base_url": "http://x", "api_key": "k"}}}'
    const res = runTestCommand(['test', valid, 'ignored-extra'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /unexpected argument: ignored-extra/i)
})

test('a stray argument to a non-test command is rejected', () => {
    const res = runTestCommand(['version', 'ignored-extra'])
    assert.equal(res.status, 1)
    assert.match(res.stderr, /unexpected argument: ignored-extra/i)
})
