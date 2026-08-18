import {resolve} from 'path'
import {spawn} from 'child_process'
import {startServer} from './server'
import {loadConfig, printServerConfig, type RuntimeConfig} from './config'
import {sqliteAvailable, openDatabase, closeDatabase, run, get} from './db'
import packageJson from '../package.json' with {type: 'json'}

const DEFAULT_CONFIG = resolve(process.cwd(), 'closerouter.json')

interface CliOptions {
    configPath: string
    detach: boolean
    command: string | undefined
}

function printVersion (): void {
    console.log(packageJson.version)
}

function printHelp (): void {
    console.log(`
closerouter — LLM proxy/router

Usage:
  closerouter [server] [-c|--config <path>] [-d|--detach]   Start the proxy server
  closerouter help                                          Show this help
  closerouter version                                       Show the version

Options:
  -c, --config <path>   Path to config file (default: closerouter.json)
  -d, --detach          Run the server in the background
`)
}

function parseCli (args: string[]): CliOptions {
    const opts: CliOptions = {configPath: DEFAULT_CONFIG, detach: false, command: undefined}

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === '-c' || arg === '--config') {
            const value = args[++i]
            if (!value) {
                console.error(`Missing value for ${arg}`)
                printHelp()
                process.exit(1)
            }
            opts.configPath = resolve(process.cwd(), value)
            continue
        }

        if (arg.startsWith('--config=')) {
            opts.configPath = resolve(process.cwd(), arg.slice('--config='.length))
            continue
        }

        if (arg === '-d' || arg === '--detach') {
            opts.detach = true
            continue
        }

        if (opts.command === undefined) opts.command = arg
    }

    return opts
}

function startDetached (configPath: string): void {
    const childArgs = ['server']
    if (configPath !== DEFAULT_CONFIG) childArgs.push('-c', configPath)

    const child = spawn(process.execPath, childArgs, {
        detached: true,
        stdio: ['ignore', 'ignore', 'inherit'],
    })
    child.unref()
    console.log(`closerouter started in background (pid ${child.pid ?? 'unknown'})`)
}

function runDbCheck (): void {
    if (!sqliteAvailable()) {
        console.error('sqlite unavailable: this binary was built without FFI (npm run build)')
        process.exit(1)
    }
    openDatabase('')
    run('CREATE TABLE IF NOT EXISTS smoke (id INTEGER PRIMARY KEY)')
    run('INSERT INTO smoke (id) VALUES (NULL)')
    const version = get('SELECT sqlite_version() AS version')?.version
    if (typeof version === 'string') console.log(`sqlite ${version} ok`)
    else console.log('sqlite ok (unknown version)')
    closeDatabase()
}

async function main (): Promise<void> {
    const args = process.argv.slice(2)
    const {configPath, detach, command} = parseCli(args)
    const config: RuntimeConfig = loadConfig(configPath)

    const isServer = command === undefined || command === 'server'

    if (isServer) {
        if (detach) {
            startDetached(configPath)
            printServerConfig(config)
            process.exit(0)
        }

        startServer(config)
        return
    }

    switch (command) {
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
        case 'db':
            runDbCheck()
            process.exit(0)
            break
        default:
            console.error(`Unknown command: ${command}`)
            printHelp()
            process.exit(1)
    }
}

main().catch((err: unknown) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : String(err))
    process.exit(1)
})
