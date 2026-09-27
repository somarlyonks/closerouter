import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'http'
import {printServerConfig, type RuntimeConfig} from '../config'
import {v1Router as handleOpenAIRequest} from './v1'
import {createUpstreamTracker, type UpstreamTracker} from './helper'
import {handle, router, path, routerErrorBoundary, type RequestContext} from '../router'
import {handleLogs, logMiddleware} from './logs'
import {handleUsage} from './usage'
import {handleStatus} from './status'
import {handleConfig} from './config'

/** A running server plus the lifecycle services its caller drives on
 *  shutdown. startServer never touches the process (`process.on`) itself. */
export interface RunningServer {
    server: Server
    upstream: UpstreamTracker
}

export function startServer (config: RuntimeConfig): RunningServer {
    const upstream = createUpstreamTracker()
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        console.log(`${req.method} ${req.url}`)
        if (!req.method || !req.url) return

        const ctx: RequestContext = {
            req,
            env: {
                config,
                upstream,
            },
            responseLog: {},
        }

        logMiddleware(ctx, res)

        routerErrorBoundary(handle(/* eslint-disable @stylistic/indent */
            router(c => c.req.method === 'OPTIONS', handleOptions,
            router(path('/v1/*'), handleOpenAIRequest,
            router(path('/status'), handleStatus,
            router(path('/logs@*'), handleLogs,
            router(path('/usage'), handleUsage,
            router(path('/config'), handleConfig,
        ))))))))(ctx, res)/* eslint-enable @stylistic/indent */
    })

    server.listen(config.port, '127.0.0.1', () => {
        const addr = server.address()
        const host = typeof addr === 'object' && addr !== null ? addr.address : '127.0.0.1'
        printServerConfig(config, host)
    })

    return {server, upstream}
}

function handleOptions (ctx: RequestContext, res: ServerResponse) {
    const requestedHeaders = ctx.req.headers['access-control-request-headers']
    const allowHeaders = typeof requestedHeaders === 'string'
        ? requestedHeaders
        : 'Content-Type, Authorization'
    res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
        'access-control-allow-headers': allowHeaders,
        'access-control-max-age': '86400',
    })
    res.end()
}
