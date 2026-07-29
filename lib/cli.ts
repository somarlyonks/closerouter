import {readFileSync, writeFileSync, existsSync} from 'fs'
import {resolve} from 'path'
import {createInterface} from 'readline'
import {spawn} from 'child_process'
import {proxyGetRequest} from './proxy.js'
import {startServer} from './server.js'

interface VagueConfig {
    port: number
    providers: Record<string, Record<string, unknown>>
}

function readRawConfig (configPath: string): VagueConfig {
    if (!existsSync(configPath)) {
        console.error(`Config file not found: ${configPath}`)
        process.exit(1)
    }
    const raw = readFileSync(configPath, 'utf-8')
    try {
        return JSON.parse(raw)
    } catch (e: unknown) {
        console.error('Invalid JSON in config file:', e instanceof Error ? e.message : String(e))
        process.exit(1)
    }
}

function writeRawModelsToConfig (configPath: string, providerName: string, models: string[]): void {
    const cfg = readRawConfig(configPath)
    const providers = cfg.providers
    if (!providers || typeof providers !== 'object') {
        console.error('Config must contain a "providers" object')
        process.exit(1)
    }
    const provider = providers[providerName]
    if (!provider) {
        console.error(`Provider "${providerName}" not found in config`)
        process.exit(1)
    }

    if (!Array.isArray(provider.models)) {
        provider.models = []
    }

    models.forEach(model => (provider.models as unknown[]).push(JSON.parse(model)))

    writeFileSync(configPath, JSON.stringify(cfg, undefined, 4) + '\n')
    console.log(`\nUpdated ${configPath}`)
}

function question (rl: ReturnType<typeof createInterface>, query: string): Promise<string> {
    return new Promise(resolve => rl.question(query, resolve))
}

type FetchedModel = {
    id: string
    raw: string
}

async function fetchModelsFromProvider (baseUrl: string, apiKey: string): Promise<FetchedModel[]> {
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl

    const {statusCode, body} = await proxyGetRequest(baseUrl, apiKey, '/models')
    if (statusCode !== 200) {
        console.error(`Provider returned status ${statusCode}: ${body}`)
        process.exit(1)
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(body)
    } catch {
        console.error(`Failed to parse response from ${normalizedBaseUrl}/models`)
        process.exit(1)
    }
    const obj = parsed as Record<string, unknown>
    if (typeof obj.data !== 'object' || !Array.isArray(obj.data)) {
        console.error(`Unexpected response format from ${normalizedBaseUrl}/models (expected {"data": [...]})`)
        process.exit(1)
    }

    const result: FetchedModel[] = []
    for (const item of obj.data) {
        const m = item as Record<string, unknown>
        if (typeof m.id === 'string') {
            result.push({id: m.id as string, raw: JSON.stringify(m)})
        }
    }
    return result
}

function getProviderInfo (configPath: string, providerName: string): {baseUrl: string, apiKey: string, existingModelIds: Set<string>} {
    const cfg = readRawConfig(configPath)
    const providers = cfg.providers as Record<string, unknown> | undefined
    if (!providers || typeof providers !== 'object') {
        console.error('Config must contain a "providers" object')
        process.exit(1)
    }
    const provider = providers[providerName] as Record<string, unknown> | undefined
    if (!provider) {
        console.error(`Provider "${providerName}" not found in config. Available: ${Object.keys(providers).join(', ')}`)
        process.exit(1)
    }
    const baseUrl = provider.base_url as string | undefined
    const apiKey = provider.api_key as string | undefined
    if (!baseUrl || !apiKey) {
        console.error(`Provider "${providerName}" is missing "base_url" or "api_key"`)
        process.exit(1)
    }
    const models = provider.models as unknown[] | undefined
    const existingModelIds = new Set<string>()
    if (models) {
        for (const m of models) {
            if (typeof m === 'string') {
                existingModelIds.add(m)
            } else if (typeof m === 'object' && m) {
                const obj = m as Record<string, unknown>
                if (typeof obj.id === 'string') {
                    existingModelIds.add(obj.id)
                }
            }
        }
    }
    return {baseUrl, apiKey, existingModelIds}
}

async function cmdFetchModels (configPath: string, providerName: string): Promise<FetchedModel[]> {
    const info = getProviderInfo(configPath, providerName)

    console.log(`Fetching models from ${info.baseUrl} ...\n`)

    const availableModels = await fetchModelsFromProvider(info.baseUrl, info.apiKey)

    if (availableModels.length === 0) {
        console.log('No models returned by provider.')
        process.exit(0)
    }

    console.log(`Found ${availableModels.length} models:\n`)
    for (let i = 0; i < availableModels.length; i++) {
        const m = availableModels[i]
        const order = String(i + 1).padStart(String(availableModels.length).length, '0')
        console.log(`  [${order}] ${m.id}`)
    }

    const alreadyConfigured = availableModels.filter(m => info.existingModelIds.has(m.id))

    if (alreadyConfigured.length > 0) {
        console.log(`\nAlready in config: ${alreadyConfigured.map(m => m.id).join(', ')}`)
    }

    return availableModels
}

async function cmdPickModel (configPath: string, providerName: string, models: string[]): Promise<void> {
    if (!models.length) {
        console.log('No models specified.')

        const rl = createInterface({input: process.stdin, output: process.stdout})
        const answer = await question(rl, '\nWould you like to add all models? (Y/n): ')
        rl.close()

        if (!answer?.toLowerCase().startsWith('y')) {
            console.log('No model selected.')
            return
        }
    }

    await addModelsToProvider(configPath, providerName, models)
}

async function addModelsToProvider (configPath: string, providerName: string, models: string[]): Promise<void> {
    const info = getProviderInfo(configPath, providerName)
    const availableModels = await cmdFetchModels(configPath, providerName)

    const modelIds = models.length ? models : availableModels.map(m => m.id)
    const collectedModels: string[] = []
    for (const modelId of modelIds) {
        if (info.existingModelIds.has(modelId)) {
            console.warn(`Model "${modelId}" is already in config.`)
            console.log(`  Skipped: ${modelId}`)
            continue
        }

        const model = availableModels.find(m => m.id === modelId)
        if (!model) {
            console.warn(`Model "${modelId}" not found on provider "${providerName}".`)
            console.log(`  Skipped: ${modelId}`)
            continue
        }

        collectedModels.push(model.raw)
        console.log(`  Added: ${modelId}`)
    }
    writeRawModelsToConfig(configPath, providerName, collectedModels)
}

function cmdListProviders (configPath: string): void {
    const cfg = readRawConfig(configPath)
    const providers = cfg.providers as Record<string, unknown> | undefined
    if (!providers || typeof providers !== 'object') return
    console.log('Configured providers:')
    for (const name of Object.keys(providers)) console.log(`  ${name}`)
}

function printHelp (): void {
    console.log(`
closerouter — LLM proxy/router

Usage:
  closerouter [server] [-d|--detach]                 Start the proxy server
  closerouter help                                   Show this help
  closerouter providers                              List configured providers
  closerouter models <provider>                      List provider's models to add
              models <provider> pick [<model>...]    Add specific model(s) to config
`)
}

async function handleModels (configPath: string): Promise<void> {
    const args = process.argv.slice(2)

    if (args.length < 2) {
        console.error('Usage: closerouter models <provider-name>')
        process.exit(1)
    }
    const providerName = args[1]
    if (args.length < 3) {
        await cmdFetchModels(configPath, providerName)
    } else {
        const subcommand = args[2]
        switch (subcommand) {
            case 'pick':
                await cmdPickModel(configPath, providerName, args.slice(3))
                break
            default:
                console.error(`Unknown command: ${subcommand}`)
                printHelp()
                process.exit(1)
        }
    }
}

async function main (): Promise<void> {
    const args = process.argv.slice(2)
    const configPath = resolve(process.cwd(), 'closerouter.json')

    const isServer = args.length === 0
        || (args.length === 1 && args[0] === '-d')
        || (args.length >= 1 && args[0] === 'server')

    if (isServer) {
        const detach = args.indexOf('-d') !== -1 || args.indexOf('--detach') !== -1
        if (detach) {
            const child = spawn(process.execPath, ['server'], {
                detached: true,
                stdio: ['ignore', 'ignore', 'inherit'],
            })
            child.unref()
            console.log(`closerouter started in background (pid ${child.pid ?? 'unknown'})`)
            process.exit(0)
        }

        startServer(configPath)
        return
    }

    const cmd = args[0]

    switch (cmd) {
        case 'providers':
            cmdListProviders(configPath)
            process.exit(0)
            break
        case 'models':
            await handleModels(configPath)
            process.exit(0)
            break
        case 'help':
        case '--help':
        case '-h':
            printHelp()
            process.exit(0)
            break
        default:
            console.error(`Unknown command: ${cmd}`)
            printHelp()
            process.exit(1)
    }
}

main().catch((err: unknown) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
})
