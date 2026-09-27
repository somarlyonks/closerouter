import {resolve} from 'path'
import {readFileSync} from 'fs'
import {spawn} from 'child_process'
import {startServer} from './server'
import {loadConfig, parseConfig, printServerConfig, type RuntimeConfig} from './config'
import {sqliteAvailable, openDatabase, closeDatabase, run, getSqliteVersion} from './db'
import {closeUsageLog, initUsage, startRetentionSweep} from './server/logs/db'
import packageJson from '../package.json' with {type: 'json'}

const DEFAULT_CONFIG = resolve(process.cwd(), 'closerouter.json')

interface CliOptions {
    configPath: string
    configExplicit: boolean
    detach: boolean
    readStdin: boolean
    command: string | undefined
    commandArg: string | undefined
}

function printVersion (): void {
    console.log(packageJson.version)
}

function printHelp (): void {
    console.log(`
closerouter - LLM proxy/router

Usage:
  closerouter [server] [-c|--config <path>] [-d|--detach]   Start the proxy server
  closerouter test [-c <path> | --stdin | <json>]           Test a config
  closerouter help                                          Show this help
  closerouter version                                       Show the version

Options:
  -c, --config <path>   Path to config file (default: closerouter.json)
  -d, --detach          Run the server in the background
`)
}

function parseCli (args: string[]): CliOptions {
    const opts: CliOptions = {
        configPath: DEFAULT_CONFIG,
        configExplicit: false,
        detach: false,
        readStdin: false,
        command: undefined,
        commandArg: undefined,
    }
    const positionals: string[] = []

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
            opts.configExplicit = true
            continue
        }

        if (arg.startsWith('--config=')) {
            opts.configPath = resolve(process.cwd(), arg.slice('--config='.length))
            opts.configExplicit = true
            continue
        }

        if (arg === '-d' || arg === '--detach') {
            opts.detach = true
            continue
        }

        if (arg === '--stdin') {
            opts.readStdin = true
            continue
        }

        positionals.push(arg)
    }

    if (positionals.length > 2) {
        console.error(`Unexpected argument: ${positionals[2]}`)
        printHelp()
        process.exit(1)
    }
    if (positionals.length > 0) opts.command = positionals[0]
    if (positionals.length > 1) opts.commandArg = positionals[1]

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

const DRAIN_PERIOD_MS = 5_000
const FORCE_EXIT_GRACE_MS = 10_000

/** Close the usage database, returning a teardown that stops the sweep and
 *  disables recording before the handle closes, so a late response 'close'
 *  handler drops its row instead of touching the dead handle. */
function initStorage ({dbPath, retentionDays}: RuntimeConfig): () => void {
    if (dbPath === undefined) return () => {}
    if (!sqliteAvailable()) {
        console.log('sqlite unavailable in this build - usage is not persisted')
        return () => {}
    }
    openDatabase(dbPath)
    run('PRAGMA journal_mode=WAL')
    initUsage()
    const sweep = startRetentionSweep(retentionDays)
    console.log(`usage log at ${dbPath}`)
    return () => {
        sweep.stop()
        closeUsageLog()
        closeDatabase()
    }
}

function runServer (config: RuntimeConfig): void {
    const closeStorage = initStorage(config)
    const {server, upstream} = startServer(config)
    let shuttingDown = false

    // server.close stops accepting connections and fires its callback once they
    // all drain; the response 'close' telemetry rows are written by then, so
    // storage can be closed and the process exited 0. Parked keep-alive sockets
    // are retired explicitly so that drain can complete; upstream work still
    // running at the drain deadline is aborted so an endless generation cannot
    // keep its connection (and the process) open; the force deadline is the
    // backstop for transports that refuse to unwind even then.
    const shutdown = (signal: string): void => {
        if (shuttingDown) {
            console.log(`received ${signal} while shutting down, forcing exit`)
            process.exit(1)
        }
        shuttingDown = true
        console.log(`received ${signal}, shutting down`)
        server.close(() => {
            closeStorage()
            process.exit(0)
        })
        // Retire parked keep-alive sockets with a FIN so server.close can
        // complete instead of waiting out their keep-alive timeout.
        server.closeIdleConnections()
        setTimeout(() => {
            const stuck = upstream.size()
            if (stuck > 0) console.log(`aborting ${stuck} in-flight upstream request(s) past the drain period`)
            upstream.abortAll()
        }, DRAIN_PERIOD_MS).unref()
        setTimeout(() => {
            console.log(`forcing shutdown after grace period`)
            process.exit(1)
        }, FORCE_EXIT_GRACE_MS).unref()
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
}

function runDbCheck (): void {
    try {
        const version = getSqliteVersion()
        console.log(`sqlite ${version} ok`)
    } catch (e) {
        console.error(e)
        process.exit(1)
    }
}

function runTest (opts: CliOptions): void {
    const sources: string[] = []
    if (opts.configExplicit) sources.push('-c/--config')
    if (opts.readStdin) sources.push('--stdin')
    if (opts.commandArg !== undefined) sources.push('a config JSON argument')
    if (sources.length > 1) {
        console.error('Cannot test multiple inputs')
        process.exit(1)
    }

    let raw = opts.commandArg
    if (opts.readStdin) {
        try {
            raw = readFileSync(0, 'utf-8')
        } catch {
            console.error('Failed to read config from stdin')
            process.exit(1)
        }
    }

    if (raw === undefined) {
        loadConfig(opts.configPath) // exitFor prints and exits 1 on failure
        return
    }

    try {
        parseConfig(raw)
    } catch (e) {
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
    }
}

async function main (): Promise<void> {
    const args = process.argv.slice(2)
    const opts = parseCli(args)
    const {configPath, detach, command} = opts

    if (opts.readStdin && command !== 'test') {
        console.error('--stdin is only supported by the test command')
        process.exit(1)
    }

    if (opts.commandArg !== undefined && command !== 'test') {
        console.error(`Unexpected argument: ${opts.commandArg}`)
        printHelp()
        process.exit(1)
    }

    if (command === 'test') {
        runTest(opts)
        process.exit(0)
    }

    const config: RuntimeConfig = loadConfig(configPath)

    const isServer = command === undefined || command === 'server'

    if (isServer) {
        if (detach) {
            startDetached(configPath)
            printServerConfig(config)
            process.exit(0)
        }

        runServer(config)
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
