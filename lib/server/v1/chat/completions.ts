import {ServerResponse} from 'http'
import {RequestContext} from '../../../util'
import {proxyRequest} from '../../../proxy'
import {Router} from '../../../router'

export function handleChatCompletions (
    ctx: RequestContext,
    res: ServerResponse,
): void {
    const chunks: Buffer[] = []
    const router = new Router(ctx.env.config)
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

        const route = router.lookup(model)
        if (!route) {
            res.writeHead(404, {'content-type': 'application/json'})
            res.end(JSON.stringify({
                error: {
                    message: `Model "${model}" is not available.}`,
                    type: 'model_not_found',
                },
            }))
            return
        }

        const rewriteBody = (body: string): string => {
            try {
                const parsed = JSON.parse(body)
                parsed.model = route.id
                return JSON.stringify(parsed)
            } catch {
                return body
            }
        }

        proxyRequest(
            req,
            res,
            route.config.base_url,
            route.config.api_key,
            '/chat/completions',
            rewriteBody,
            bodyStr,
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
