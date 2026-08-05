import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'http'
import {randomUUID} from 'crypto'
import {loadConfig} from '../config'
import {v1Router as handleOpenAIRequest} from './v1'
import {router, type RequestContext} from '../util'
import {handleLogs, logMiddleware} from './logs'
import {handleStatus} from './status'

export function startServer (configPath: string): Server {
    const config = loadConfig(configPath)
    const apiKey = config.key || `sk-cr-${randomUUID()}`

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        console.log(`${req.method} ${req.url}`)
        if (!req.method || !req.url) return

        const ctx: RequestContext = {
            req,
            env: {
                host: process.env.HOST ?? 'localhost',
                config,
                apiKey,
            },
            responseLog: {},
        }

        logMiddleware(ctx, res)

        router(
            c => c.req.method === 'OPTIONS',
            handleOptions,
            router(
                c => !!c.req.url?.startsWith('/v1/'),
                handleOpenAIRequest,
                router(
                    c => c.req.url === '/status',
                    handleStatus,
                    router(
                        c => c.req.url === '/logs',
                        handleLogs,
                    ),
                ),
            ),
        )(ctx, res)
    })

    const port = config.port || 6712

    server.listen(port, () => {
        console.log(`closerouter running on http://localhost:${port}`)
        console.log(`API key: ${apiKey}`)
        console.log(`Providers:`)
        for (const p of Object.keys(config.providers)) console.log(`  ${p}`)
    })

    const shutdown = (sig: string) => () => {
        console.log(`received ${sig}, shutting down`)
        // server.close stops accepting new connections and waits for in-flight
        // responses to drain. SSE /logs streams and parked keep-alive clients are
        // long-lived, though, so arm a grace-period force-quit so supervisors can
        // recycle the process reliably instead of hanging indefinitely.
        server.close(() => process.exit(0))
        const force = setTimeout(() => {
            console.log(`forcing shutdown after grace period`)
            process.exit(1)
        }, 10000)
        force.unref()
    }
    process.on('SIGTERM', shutdown('SIGTERM'))
    process.on('SIGINT', shutdown('SIGINT'))

    return server
}

function handleOptions (_ctx: RequestContext, res: ServerResponse) {
    res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
        'access-control-max-age': '86400',
    })
    res.end()
}
