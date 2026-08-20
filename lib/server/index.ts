import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'http'
import {printServerConfig, type RuntimeConfig} from '../config'
import {closeDatabase} from '../db'
import {v1Router as handleOpenAIRequest} from './v1'
import {router, type RequestContext, type RequestHandler} from '../util'
import {handleLogs, logMiddleware} from './logs'
import {handleUsage} from './usage'
import {handleStatus} from './status'
import {handleConfig} from './config'

export function startServer (config: RuntimeConfig): Server {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        console.log(`${req.method} ${req.url}`)
        if (!req.method || !req.url) return

        const ctx: RequestContext = {
            req,
            env: {
                config,
            },
            responseLog: {},
        }

        logMiddleware(ctx, res)

        routerErrorBoundary(router(
            c => c.req.method === 'OPTIONS',
            handleOptions,
            router(
                c => !!c.req.url?.startsWith('/v1/'),
                handleOpenAIRequest,
                router(
                    c => c.req.url === '/status',
                    handleStatus,
                    router(
                        c => c.req.url === '/logs' || !!c.req.url?.startsWith('/logs/'),
                        handleLogs,
                        router(
                            c => c.req.url === '/usage',
                            handleUsage,
                            router(
                                c => c.req.url === '/config',
                                handleConfig,
                            ),
                        ),
                    ),
                ),
            ),
        ))(ctx, res)
    })

    server.listen(config.port, () => {
        printServerConfig(config)
    })

    const shutdown = (sig: string) => () => {
        console.log(`received ${sig}, shutting down`)
        closeDatabase()
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
        'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
        'access-control-max-age': '86400',
    })
    res.end()
}

function routerErrorBoundary (handler: RequestHandler): RequestHandler {
    return (ctx, res) => {
        try {
            handler(ctx, res)
        } catch (e) {
            console.error(e)
            res.writeHead(500)
            res.end()
        }
    }
}
