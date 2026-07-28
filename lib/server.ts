import {createServer, IncomingMessage, ServerResponse} from 'http'
import {loadConfig, resolveConfigPath} from './config.js'
import {Router} from './router.js'
import {handleChatCompletions} from './routes/chat.js'
import {handleListModels} from './routes/models.js'

const configPath = resolveConfigPath()
const config = loadConfig(configPath)
const router = new Router(config)

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method
    const url = req.url

    console.log(`${method} ${url}`)

    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'Content-Type, Authorization',
            'access-control-max-age': '86400',
        })
        res.end()
        return
    }

    const path = url ? (url.includes('?') ? url.slice(0, url.indexOf('?')) : url) : '/'

    if (method === 'POST' && path === '/v1/chat/completions') {
        handleChatCompletions(req, res, router)
    } else if (method === 'GET' && path === '/v1/models') {
        handleListModels(req, res, router)
    } else {
        res.writeHead(404, {'content-type': 'application/json'})
        res.end(JSON.stringify({
            error: {
                message: `Not found: ${method} ${path}`,
                type: 'not_found',
            },
        }))
    }
})

server.listen(config.port, () => {
    console.log(`closerouter running on http://localhost:${config.port}`)
    console.log(`Providers: ${Object.keys(config.providers).join(', ')}`)
    console.log(`Models: ${router.listModels().join(', ')}`)
})
