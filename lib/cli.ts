import {resolve} from 'path'
import {spawn} from 'child_process'
import {startServer} from './server'
import {loadConfig, printServerConfig} from './config'
import packageJson from '../package.json' with {type: 'json'}

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
`)
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
