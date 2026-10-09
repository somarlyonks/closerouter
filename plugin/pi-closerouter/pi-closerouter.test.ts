import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {AddressInfo} from 'node:net'
import {getBuiltinModels, getBuiltinProviders} from '@earendil-works/pi-ai/providers/all'
import {normalizeBaseUrl, resolveAgentDir, resolveSettings, type CloserouterSettings, type ConfigSources} from './config.ts'
import {parseListedModels, toProviderModel, type ChatModel} from './models.ts'
import registerCloserouter, {discoverModels, providerConfig, resolveModels, warmModels} from './index.ts'

const sources = (over: Partial<ConfigSources> = {}): ConfigSources => ({
    env: {},
    cwd: '/work',
    homeDir: '/home/u',
    readText: () => undefined,
    ...over,
})

const crSettings = (over: Partial<CloserouterSettings> = {}): CloserouterSettings => ({
    baseUrl: 'http://127.0.0.1:6712/v1',
    apiKey: 'sk-test',
    models: [],
    ...over,
})

async function startModelsServer (
    handler: (url: string, authorization: string | undefined) => {status: number, body: unknown},
): Promise<{baseUrl: string, requests: Array<{url: string, authorization: string | undefined}>, close: () => Promise<void>}> {
    const requests: Array<{url: string, authorization: string | undefined}> = []
    const server = createServer((req, res) => {
        requests.push({url: req.url ?? '', authorization: req.headers.authorization})
        const {status, body} = handler(req.url ?? '', req.headers.authorization)
        res.writeHead(status, {'content-type': 'application/json'})
        res.end(JSON.stringify(body))
    })
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    const {port} = server.address() as AddressInfo
    return {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise<void>(ok => server.close(() => ok())),
    }
}

test('resolveSettings falls back to the closerouter defaults', () => {
    assert.deepEqual(resolveSettings(sources()), {
        baseUrl: 'http://127.0.0.1:6712/v1',
        apiKey: 'sk-cr-kee9itsecr1t',
        models: [],
    })
})

test('resolveSettings reads port and key from a closerouter config', () => {
    const settings = resolveSettings(sources({
        readText: file => file === '/work/closerouter.json' ? '{"port": 9001, "key": "sk-server"}' : undefined,
    }))
    assert.equal(settings.baseUrl, 'http://127.0.0.1:9001/v1')
    assert.equal(settings.apiKey, 'sk-server')
})

test('resolveSettings reads the closerouter field from pi settings', () => {
    const readText = (file: string) => file === '/home/u/.pi/agent/settings.json'
        ? '{"closerouter": {"baseUrl": "gateway.local:7000", "apiKey": "sk-settings", "models": ["a/b", {"id": "a/e", "reasoning": true}, {"id": "ark/x", "$alias": "a/b"}]}}'
        : undefined
    const settings = resolveSettings(sources({readText}))
    assert.equal(settings.baseUrl, 'http://gateway.local:7000/v1')
    assert.equal(settings.apiKey, 'sk-settings')
    assert.deepEqual(settings.models, [{id: 'a/b'}, {id: 'a/e', reasoning: true}, {id: 'ark/x', $alias: 'a/b'}])
})

test('environment overrides pi settings and settings overrides the closerouter config', () => {
    const readText = (file: string) => {
        if (file === '/home/u/.pi/agent/settings.json') return '{"closerouter": {"baseUrl": "settings.test:7000", "apiKey": "sk-settings"}}'
        if (file === '/work/closerouter.json') return '{"port": 9001, "key": "sk-server"}'
        return undefined
    }
    const fromSettings = resolveSettings(sources({readText}))
    assert.equal(fromSettings.baseUrl, 'http://settings.test:7000/v1')
    assert.equal(fromSettings.apiKey, 'sk-settings')

    const fromEnv = resolveSettings(sources({readText, env: {CLOSEROUTER_URL: 'https://router.test/v1', CLOSEROUTER_KEY: 'sk-env'}}))
    assert.equal(fromEnv.baseUrl, 'https://router.test/v1')
    assert.equal(fromEnv.apiKey, 'sk-env')
})

test('resolveSettings reads settings from PI_CODING_AGENT_DIR', () => {
    const readText = (file: string) => file === '/custom/settings.json' ? '{"closerouter": {"baseUrl": "agent.test:8000"}}' : undefined
    const settings = resolveSettings(sources({readText, env: {PI_CODING_AGENT_DIR: '/custom'}}))
    assert.equal(settings.baseUrl, 'http://agent.test:8000/v1')
})

test('resolveAgentDir prefers PI_CODING_AGENT_DIR', () => {
    assert.equal(resolveAgentDir({env: {PI_CODING_AGENT_DIR: '/agent'}, homeDir: '/home/u'}), '/agent')
    assert.equal(resolveAgentDir({env: {}, homeDir: '/home/u'}), '/home/u/.pi/agent')
})

test('normalizeBaseUrl adds a scheme and the /v1 suffix once', () => {
    assert.equal(normalizeBaseUrl('127.0.0.1:6712'), 'http://127.0.0.1:6712/v1')
    assert.equal(normalizeBaseUrl('http://127.0.0.1:6712/'), 'http://127.0.0.1:6712/v1')
    assert.equal(normalizeBaseUrl('https://router.test/v1'), 'https://router.test/v1')
})

test('parseListedModels keeps only entries with an id', () => {
    assert.deepEqual(parseListedModels({object: 'list', data: [{id: 'a/b'}, {name: 'x'}, null, 'y']}), [{id: 'a/b'}])
    assert.deepEqual(parseListedModels({}), [])
    assert.deepEqual(parseListedModels(undefined), [])
})

test('toProviderModel fills the metadata pi requires', () => {
    assert.deepEqual(toProviderModel({id: 'nope/unknown'}, undefined), {
        id: 'nope/unknown',
        api: 'openai-completions',
        name: 'nope/unknown',
        reasoning: false,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    })
})

test('toProviderModel derives what the provider passes through', () => {
    const model = toProviderModel({
        id: 'local/model',
        context_length: 200000,
        max_tokens: 64000,
        supports_reasoning: true,
        vision: true,
        pricing: {prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003'},
    }, undefined)
    assert.equal(model.contextWindow, 200000)
    assert.equal(model.maxTokens, 64000)
    assert.equal(model.reasoning, true)
    assert.deepEqual(model.input, ['text', 'image'])
    assert.deepEqual(model.cost, {input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0})
})

test('toProviderModel fills specs from pi\'s bundled catalog', () => {
    const provider = builtinProviders().find(id => builtinModels(id).length > 0)
    assert.ok(provider)
    const spec = builtinModels(provider)[0]
    const model = toProviderModel({id: `${provider}/${spec.id}`}, undefined)
    assert.equal(model.name, spec.name)
    assert.equal(model.reasoning, spec.reasoning)
    assert.equal(model.contextWindow, spec.contextWindow)
    assert.equal(model.maxTokens, spec.maxTokens)
    assert.deepEqual(model.input, spec.input)
    assert.deepEqual(model.cost, spec.cost)
    assert.deepEqual(model.thinkingLevelMap, isOpenaiApi(spec.api) ? spec.thinkingLevelMap : undefined)
})

test('toProviderModel lets an override win over pi\'s catalog', () => {
    const provider = builtinProviders().find(id => builtinModels(id).length > 0)
    assert.ok(provider)
    const spec = builtinModels(provider)[0]
    const model = toProviderModel({id: `${provider}/${spec.id}`}, {name: 'Custom', contextWindow: 4242, reasoning: !spec.reasoning})
    assert.equal(model.name, 'Custom')
    assert.equal(model.contextWindow, 4242)
    assert.equal(model.reasoning, !spec.reasoning)
})

test('toProviderModel inherits a catalog spec through $alias', () => {
    const provider = builtinProviders().find(id => builtinModels(id).length > 0)
    assert.ok(provider)
    const spec = builtinModels(provider)[0]
    const model = toProviderModel({id: 'ark/unknown-model'}, {$alias: `${provider}/${spec.id}`})
    assert.equal(model.id, 'ark/unknown-model')
    assert.equal(model.name, spec.name)
    assert.equal(model.reasoning, spec.reasoning)
    assert.equal(model.contextWindow, spec.contextWindow)
    assert.equal(model.maxTokens, spec.maxTokens)
    assert.deepEqual(model.input, spec.input)
    assert.deepEqual(model.cost, spec.cost)
})

test('toProviderModel lets an explicit field win over $alias and drops $alias', () => {
    const provider = builtinProviders().find(id => builtinModels(id).length > 0)
    assert.ok(provider)
    const spec = builtinModels(provider)[0]
    const model = toProviderModel({id: 'ark/unknown-model'}, {$alias: `${provider}/${spec.id}`, name: 'Custom', contextWindow: 4242})
    assert.equal(model.id, 'ark/unknown-model')
    assert.equal(model.name, 'Custom')
    assert.equal(model.contextWindow, 4242)
    assert.equal(Object.hasOwn(model, '$alias'), false)
})

test('toProviderModel never copies pi\'s compat for another wire format, but honors an override', () => {
    const otherProvider = builtinProviders().find(id =>
        builtinModels(id).some(model => !isOpenaiApi(model.api) && model.compat !== undefined))
    assert.ok(otherProvider)
    const otherSpec = builtinModels(otherProvider).find(model => !isOpenaiApi(model.api) && model.compat !== undefined)
    assert.ok(otherSpec)
    assert.equal(toProviderModel({id: `${otherProvider}/${otherSpec.id}`}, undefined).compat, undefined)

    const compat = {thinkingFormat: 'deepseek' as const, maxTokensField: 'max_tokens' as const}
    assert.deepEqual(toProviderModel({id: 'local/model'}, {compat}).compat, compat)
})

test('toProviderModel copies compat from an OpenAI catalog spec', () => {
    const provider = builtinProviders().find(id =>
        builtinModels(id).some(model => isOpenaiApi(model.api) && model.compat !== undefined))
    assert.ok(provider)
    const spec = builtinModels(provider).find(model => isOpenaiApi(model.api) && model.compat !== undefined)
    assert.ok(spec)
    assert.deepEqual(toProviderModel({id: `${provider}/${spec.id}`}, undefined).compat, spec.compat)
})

test('toProviderModel passes through any other model field an override sets', () => {
    const model = toProviderModel({id: 'local/model'}, {
        promptCache: {short: 300, long: 3600},
        samplingParams: {temperature: 0.5},
    })
    assert.deepEqual(model.promptCache, {short: 300, long: 3600})
    assert.deepEqual(model.samplingParams, {temperature: 0.5})
})

test('toProviderModel takes an OpenAI API from pi\'s catalog and ignores other wire formats', () => {
    const responsesProvider = builtinProviders().find(id => builtinModels(id).some(model => model.api === 'openai-responses'))
    if (responsesProvider) {
        const spec = builtinModels(responsesProvider).find(model => model.api === 'openai-responses')
        assert.ok(spec)
        assert.equal(toProviderModel({id: `${responsesProvider}/${spec.id}`}, undefined).api, 'openai-responses')
    }

    const otherProvider = builtinProviders().find(id => builtinModels(id).some(model => !isOpenaiApi(model.api)))
    assert.ok(otherProvider)
    const otherSpec = builtinModels(otherProvider).find(model => !isOpenaiApi(model.api))
    assert.ok(otherSpec)
    assert.equal(toProviderModel({id: `${otherProvider}/${otherSpec.id}`}, undefined).api, 'openai-completions')

    assert.equal(toProviderModel({id: 'local/model'}, undefined).api, 'openai-completions')
    assert.equal(toProviderModel({id: 'local/model'}, {api: 'openai-responses'}).api, 'openai-responses')
})

test('providerConfig defaults to openai-completions', () => {
    assert.equal(providerConfig(crSettings()).api, 'openai-completions')
})

test('toProviderModel lets an override win', () => {
    const model = toProviderModel({id: 'a/b', context_window: 8000}, {name: 'A', contextWindow: 32000, reasoning: true})
    assert.equal(model.name, 'A')
    assert.equal(model.contextWindow, 32000)
    assert.equal(model.reasoning, true)
})

test('discoverModels maps GET /v1/models with the gateway key', async () => {
    const server = await startModelsServer(() => ({
        status: 200,
        body: {object: 'list', data: [{id: 'local/model', context_length: 64000}]},
    }))
    try {
        const models = await discoverModels(crSettings({baseUrl: server.baseUrl}))
        assert.deepEqual(models.map(model => model.id), ['local/model'])
        assert.equal(models[0].contextWindow, 64000)
        assert.deepEqual(server.requests, [{url: '/v1/models', authorization: 'Bearer sk-test'}])
    } finally {
        await server.close()
    }
})

test('discoverModels keeps only the configured model ids', async () => {
    const server = await startModelsServer(() => ({
        status: 200,
        body: {object: 'list', data: [{id: 'a/b', context_length: 64000}, {id: 'c/d'}, {id: 'a/e'}]},
    }))
    try {
        const models = await discoverModels(crSettings({baseUrl: server.baseUrl, models: [{id: 'a/b', contextWindow: 4096}, {id: 'a/e'}]}))
        assert.deepEqual(models.map(model => model.id), ['a/b', 'a/e'])
        assert.equal(models[0].contextWindow, 4096)
    } finally {
        await server.close()
    }
})

test('discoverModels exposes a configured model the gateway does not report', async () => {
    const server = await startModelsServer(() => ({status: 200, body: {object: 'list', data: [{id: 'provider/known'}]}}))
    try {
        const models = await discoverModels(crSettings({
            baseUrl: server.baseUrl,
            models: [{id: 'provider/known'}, {id: 'ark/deepseek-v4.1-flash'}],
        }))
        assert.deepEqual(models.map(model => model.id), ['provider/known', 'ark/deepseek-v4.1-flash'])
        assert.equal(models[1].name, 'ark/deepseek-v4.1-flash')
        assert.equal(models[1].contextWindow, 128000)
        assert.equal(models[1].reasoning, false)
    } finally {
        await server.close()
    }
})

test('discoverModels inherits a catalog spec for an unreported model through $alias', async () => {
    const provider = builtinProviders().find(id => builtinModels(id).length > 0)
    assert.ok(provider)
    const spec = builtinModels(provider)[0]
    const server = await startModelsServer(() => ({status: 200, body: {object: 'list', data: []}}))
    try {
        const models = await discoverModels(crSettings({
            baseUrl: server.baseUrl,
            models: [{$alias: `${provider}/${spec.id}`, id: 'ark/unknown-model'}],
        }))
        assert.equal(models[0].id, 'ark/unknown-model')
        assert.equal(models[0].contextWindow, spec.contextWindow)
        assert.equal(models[0].maxTokens, spec.maxTokens)
    } finally {
        await server.close()
    }
})

test('discoverModels throws when the gateway is unreachable', async () => {
    const server = await startModelsServer(() => ({status: 503, body: {error: 'down'}}))
    try {
        await assert.rejects(discoverModels(crSettings({baseUrl: server.baseUrl, apiKey: 'k'})), /503/)
    } finally {
        await server.close()
    }
})

test('warmModels discovers and applies the models', async () => {
    const server = await startModelsServer(() => ({status: 200, body: {object: 'list', data: [{id: 'a/b'}]}}))
    try {
        const applied: ChatModel[][] = []
        await warmModels(crSettings({baseUrl: server.baseUrl}), models => applied.push(models))
        assert.deepEqual(applied.map(models => models.map(model => model.id)), [['a/b']])
        assert.deepEqual(server.requests, [{url: '/v1/models', authorization: 'Bearer sk-test'}])
    } finally {
        await server.close()
    }
})

test('providerConfig refreshes over the network only when allowed', async () => {
    const server = await startModelsServer(() => ({status: 200, body: {object: 'list', data: [{id: 'a/b'}]}}))
    try {
        const config = providerConfig(crSettings({baseUrl: server.baseUrl}))
        const offline = await config.refreshModels!(refreshContext(false))
        assert.deepEqual(offline, [])
        assert.equal(server.requests.length, 0)

        const online = await config.refreshModels!(refreshContext(true))
        assert.deepEqual(online.map(model => model.id), ['a/b'])
        assert.equal(server.requests.length, 1)
    } finally {
        await server.close()
    }
})

test('the extension factory registers without waiting on the gateway', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-closerouter-'))
    const restore = setEnv({PI_CODING_AGENT_DIR: agentDir, CLOSEROUTER_URL: 'http://127.0.0.1:1', CLOSEROUTER_KEY: 'sk-env'})
    try {
        const registrations: CapturedProvider[] = []
        const returned: unknown = registerCloserouter({
            registerProvider: (_id: string, config: unknown) => {registrations.push(config as CapturedProvider)},
        } as never)
        // Synchronous: the provider is registered before any network call settles.
        assert.equal(returned, undefined)
        assert.equal(registrations.length, 1)
        assert.equal(registrations[0].api, 'openai-completions')
        assert.deepEqual(registrations[0].models, [])
    } finally {
        restore()
        rmSync(agentDir, {recursive: true, force: true})
    }
})

test('the extension factory seeds configured models so an offline resume can restore them', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-closerouter-'))
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
        closerouter: {models: [{id: 'ark/deepseek-v4.1-flash', $alias: 'deepseek/deepseek-flash'}]},
    }))
    const restore = setEnv({PI_CODING_AGENT_DIR: agentDir, CLOSEROUTER_URL: 'http://127.0.0.1:1', CLOSEROUTER_KEY: 'sk-env'})
    try {
        const registrations: CapturedProvider[] = []
        registerCloserouter({
            registerProvider: (_id: string, config: unknown) => {registrations.push(config as CapturedProvider)},
        } as never)
        assert.deepEqual(registrations[0].models?.map(model => model.id), ['ark/deepseek-v4.1-flash'])
    } finally {
        restore()
        rmSync(agentDir, {recursive: true, force: true})
    }
})

test('an offline refresh returns the seeded configured models', async () => {
    const settings = crSettings({models: [{id: 'ark/deepseek-v4.1-flash'}]})
    const config = providerConfig(settings, resolveModels(settings.models, []))
    const models = await config.refreshModels!(refreshContext(false))
    assert.deepEqual(models.map(model => model.id), ['ark/deepseek-v4.1-flash'])
})

interface CapturedProvider {
    api?: string
    baseUrl?: string
    apiKey?: string
    models?: Array<{id: string}>
    refreshModels?: (context: {allowNetwork: boolean, signal: AbortSignal}) => Promise<Array<{id: string}>>
}

function refreshContext (allowNetwork: boolean) {
    return {allowNetwork, signal: new AbortController().signal, publish: async () => true}
}

const builtinModels = getBuiltinModels as unknown as (provider: string) => Array<{
    id: string
    name: string
    api: string
    reasoning: boolean
    thinkingLevelMap?: Record<string, string | null>
    input: Array<'text' | 'image'>
    cost: unknown
    contextWindow: number
    maxTokens: number
    compat?: unknown
}>
const builtinProviders = getBuiltinProviders as unknown as () => string[]

const isOpenaiApi = (api: string) => api === 'openai-completions' || api === 'openai-responses'

function setEnv (values: Record<string, string>): () => void {
    const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]))
    Object.assign(process.env, values)
    return () => {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}
