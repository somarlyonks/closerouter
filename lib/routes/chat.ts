import {IncomingMessage, ServerResponse} from 'http'
import {Router} from '../router.js'
import {proxyRequest} from '../proxy.js'

export function handleChatCompletions (
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    router: Router,
): void {
    const chunks: Buffer[] = []
    clientReq.on('data', (chunk: Buffer) => chunks.push(chunk))
    clientReq.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf-8')

        let model: string | undefined
        try {
            const body = JSON.parse(bodyStr)
            model = body.model
        } catch {
            clientRes.writeHead(400, {'content-type': 'application/json'})
            clientRes.end(JSON.stringify({
                error: {
                    message: 'Invalid JSON in request body',
                    type: 'invalid_request_error',
                },
            }))
            return
        }

        if (!model) {
            clientRes.writeHead(400, {'content-type': 'application/json'})
            clientRes.end(JSON.stringify({
                error: {
                    message: 'Missing "model" field in request body',
                    type: 'invalid_request_error',
                },
            }))
            return
        }

        const route = router.lookup(model)
        if (!route) {
            clientRes.writeHead(404, {'content-type': 'application/json'})
            clientRes.end(JSON.stringify({
                error: {
                    message: `Model "${model}" is not configured. Available models: ${router.listModels().map(m => m.id).join(', ')}`,
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
            clientReq,
            clientRes,
            route.config.base_url,
            route.config.api_key,
            '/chat/completions',
            rewriteBody,
            bodyStr,
        )
    })

    clientReq.on('error', (err) => {
        console.error('Error reading chat request body:', err)
        if (!clientRes.headersSent) {
            clientRes.writeHead(400, {'content-type': 'application/json'})
            clientRes.end(JSON.stringify({
                error: {
                    message: `Failed to read request: ${err.message}`,
                    type: 'client_error',
                },
            }))
        }
    })
}
