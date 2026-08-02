import {ServerResponse} from 'http'
import type {RequestContext} from '../../../util'
import {proxyRequest} from '../../../proxy'

export function handleChatCompletions (
    ctx: RequestContext,
    res: ServerResponse,
): void {
    const chunks: Buffer[] = []
    const req = ctx.req
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf-8')

        let model: string | undefined
        try {
            const body = JSON.parse(bodyStr)
            model = body.model
        } catch {
            res.writeHead(400, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: 'Invalid JSON in request body',
                    type: 'invalid_request_error',
                },
            }))
            return
        }

        if (!model) {
            res.writeHead(400, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: 'Missing "model" field in request body',
                    type: 'invalid_request_error',
                },
            }))
            return
        }

        const slashIdx = model.indexOf('/')
        const providerName = model.slice(0, slashIdx)
        const realModel = model.slice(slashIdx + 1)
        if (slashIdx <= 0 || !providerName || !realModel) {
            res.writeHead(404, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: `Model "${model}" is unavailable`,
                    type: 'model_not_found',
                },
            }))
            return
        }

        const provider = ctx.env.config.providers[providerName]
        if (!provider) {
            res.writeHead(404, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: `Provider "${providerName}" is not configured`,
                    type: 'model_not_found',
                },
            }))
            return
        }

        const rewriteBody = (body: string): string => {
            try {
                const parsed = JSON.parse(body)
                parsed.model = realModel
                return JSON.stringify(parsed)
            } catch {
                return body
            }
        }

        proxyRequest(
            req,
            res,
            provider.base_url,
            provider.api_key,
            '/chat/completions',
            rewriteBody,
            bodyStr,
            ctx.responseLog,
        )
    })

    req.on('error', (err) => {
        console.error('Error reading chat request body:', err)
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
}
