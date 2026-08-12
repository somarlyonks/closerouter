import {writeFileSync} from 'fs'
import {resolve} from 'path'
import {createInterface} from 'readline'
import {spawn} from 'child_process'
import {proxyGetRequest} from './proxy'
import {startServer} from './server'
import {loadConfig, printServerConfig, type RuntimeConfig} from './config'
import packageJson from '../package.json' with {type: 'json'}

function writeRawModelsToConfig (config: RuntimeConfig, providerName: string, models: string[]): void {
    const configPath = config.path
    const providers = config.providers
    if (!providers || typeof providers !== 'object') {
        console.error('Config must contain a "providers" object')
        process.exit(1)
    }
    const provider = providers[providerName] as unknown as Record<string, unknown>
    if (!provider) {
        console.error(`Provider "${providerName}" not found in config`)
        process.exit(1)
    }

    if (!Array.isArray(provider.models)) {
        provider.models = []
    }

    models.forEach(model => (provider.models as unknown[]).push(JSON.parse(model)))

    writeFileSync(configPath, JSON.stringify(config, undefined, 4) + '\n')
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

function getProviderInfo (config: RuntimeConfig, providerName: string): {baseUrl: string, apiKey: string, existingModelIds: Set<string>} {
    const providers = config.providers

    const provider = providers[providerName]
    if (!provider) {
        console.error(`Provider "${providerName}" not found in config. Available: ${Object.keys(providers).join(', ')}`)
        process.exit(1)
    }
    const baseUrl = provider.base_url
    const apiKey = provider.api_key
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

async function cmdFetchModels (config: RuntimeConfig, providerName: string): Promise<FetchedModel[]> {
    const info = getProviderInfo(config, providerName)

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

async function cmdPickModel (config: RuntimeConfig, providerName: string, models: string[]): Promise<void> {
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

    await addModelsToProvider(config, providerName, models)
}

async function addModelsToProvider (config: RuntimeConfig, providerName: string, models: string[]): Promise<void> {
    const info = getProviderInfo(config, providerName)
    const availableModels = await cmdFetchModels(config, providerName)

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
    writeRawModelsToConfig(config, providerName, collectedModels)
}

function cmdListProviders ({providers}: RuntimeConfig): void {
    console.log('Configured providers:')
    for (const name of Object.keys(providers)) console.log(`  ${name}`)
}

function printVersion (): void {
    console.log(packageJson.version)
}

function printHelp (): void {
    console.log(`
closerouter — LLM proxy/router

Usage:
  closerouter [server] [-d|--detach]                 Start the proxy server
  closerouter help                                   Show this help
  closerouter version                                Show the version
  closerouter providers                              List configured providers
  closerouter models <provider>                      List provider's models to add
              models <provider> pick [<model>...]    Add specific model(s) to config
`)
}

async function handleModels (config: RuntimeConfig): Promise<void> {
    const args = process.argv.slice(2)

    if (args.length < 2) {
        console.error('Usage: closerouter models <provider-name>')
        process.exit(1)
    }
    const providerName = args[1]
    if (args.length < 3) {
        await cmdFetchModels(config, providerName)
    } else {
        const subcommand = args[2]
        switch (subcommand) {
            case 'pick':
                await cmdPickModel(config, providerName, args.slice(3))
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
    const config = loadConfig(configPath)

    const isServer = args.length === 0
        || (args.length === 1 && (args[0] === '-d' || args[0] === '--detach'))
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
            printServerConfig(config)
            process.exit(0)
        }

        startServer(config)
        return
    }

    const cmd = args[0]

    switch (cmd) {
        case 'providers':
            cmdListProviders(config)
            process.exit(0)
            break
        case 'models':
            await handleModels(config)
            process.exit(0)
            break
        case 'version':
        case '--version':
        case '-v':
            printVersion()
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
