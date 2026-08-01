import {createServer, IncomingMessage, ServerResponse} from 'http'
import {randomUUID} from 'crypto'
import {loadConfig} from '../config'
import {v1Router as handleOpenAIRequest} from './v1'
import {router, RequestContext} from '../util'

export function startServer (configPath: string): void {
    const config = loadConfig(configPath)
    const apiKey = config.key || `sk-cr-${randomUUID()}`

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const method = req.method
        console.log(`${method} ${req.url}`)
        if (!req.url) {
            return
        }

        const ctx: RequestContext = {
            req,
            env: {
                host: process.env.HOST ?? 'localhost',
                config,
                apiKey,
            },
        }

        router(
            c => c.req.method === 'OPTIONS',
            handleOptions,
            router(
                r => !!r.req.url?.startsWith('/v1/'),
                handleOpenAIRequest,
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
