import {writeFileSync} from 'fs'
import {parseConfig, applyConfig} from '../config'
import {needsAuth, withMethod, handleBadRequest} from '../util'

export const handleConfig = needsAuth(withMethod('PUT')(
    (ctx, res) => {
        const chunks: Buffer[] = []
        ctx.req.on('data', (chunk: Buffer) => chunks.push(chunk))
        ctx.req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8')

            let config
            try {
                config = parseConfig(raw)
            } catch (e) {
                return handleBadRequest(res, e instanceof Error ? e.message : 'Invalid config')
            }

            const previousPort = ctx.env.config.port
            applyConfig(ctx.env.config, config)

            if (previousPort !== undefined && config.port !== previousPort) {
                console.log(
                    `config port changed ${previousPort} -> ${config.port}; restart for the new port to take effect`,
                )
            }

            try {
                writeFileSync(ctx.env.config.path, JSON.stringify(config, undefined, 4) + '\n')
            } catch (e) {
                console.error('Failed to persist config:', e instanceof Error ? e.message : e)
                res.writeHead(500, {'content-type': 'application/json'})
                res.end(JSON.stringify({
                    error: {
                        message: 'Config updated in memory but failed to persist to disk',
                        type: 'persistence_error',
                    },
                }))
                return
            }

            res.writeHead(200, {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
            })
            res.end(JSON.stringify(config, undefined, 2))
        })
        ctx.req.on('error', (err: Error) => {
            if (!res.headersSent) {
                res.writeHead(400, {'content-type': 'application/json'})
                res.end(JSON.stringify({
                    error: {
                        message: `Failed to read request: ${err.message}`,
                        type: 'client_error',
                    },
                }))
            }
        })
    },
))
