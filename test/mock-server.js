// Standalone OpenAI-format mock backend + its closerouter test config, for
// manual / app-level testing. Streams a chat.completions SSE response on
// /v1/chat/completions and answers every other path with {ok: true}.
//
// The closerouter test config that points a "mock" provider here lives in
// `mockConfig()` (below). Running the script directly writes it to
// `mock-server.config.json` in this directory, so a test runner can find the
// config alongside the backend:
//
//   node test/mock-server.js [mockPort]      # starts backend, writes config
//   ./dist/closerouter server -c test/mock-server.config.json
//
// A test runner can also import the pieces directly:
//   import {mockConfig, startMockServer} from './mock-server.js'
//
// Mock port: argv[2] or MOCK_PORT, default 9999. Closerouter port in the
// generated config: CR_PORT, default 6799.

import http from 'http'
import {writeFileSync} from 'fs'
import {dirname, join} from 'path'
import {fileURLToPath, pathToFileURL} from 'url'

const DEFAULT_MOCK_PORT = 9999
const DEFAULT_CR_PORT = 6799
const KEY = 'sk-cr-testkey123'

export function mockConfig (mockPort = DEFAULT_MOCK_PORT, crPort = DEFAULT_CR_PORT) {
    return {
        port: crPort,
        key: KEY,
        providers: {
            mock: {
                base_url: `http://127.0.0.1:${mockPort}/v1`,
                api_key: 'sk-mock',
                models: ['mock-1'],
            },
        },
    }
}

const chunks = [
    {id: 'chatcmpl-mock1', object: 'chat.completion.chunk', model: 'mock-1', choices: [{index: 0, delta: {role: 'assistant', content: 'Hello'}}]},
    {id: 'chatcmpl-mock1', object: 'chat.completion.chunk', model: 'mock-1', choices: [{index: 0, delta: {content: ' world'}}]},
    {id: 'chatcmpl-mock1', object: 'chat.completion.chunk', model: 'mock-1', choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 2}},
    '[DONE]',
]

export function startMockServer (port = DEFAULT_MOCK_PORT) {
    const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
            setTimeout(() => {
                if (req.url === '/v1/chat/completions') {
                    res.writeHead(200, {'content-type': 'text/event-stream'})
                    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
                    res.end()
                    return
                }
                res.writeHead(200, {'content-type': 'application/json'})
                res.end(JSON.stringify({ok: true, method: req.method, url: req.url}))
            }, responseDelay(body))
        })
    })

    return new Promise(resolve => {
        server.listen(port, '127.0.0.1', () => {
            const bound = server.address().port
            resolve({
                port: bound,
                close: () => new Promise(r => server.close(r)),
            })
        })
    })

    /**
     * Delay before responding: 1–100ms by default, 3000–6000ms when the last
     * user message's content starts with "slow". Lets the logs view show a real
     * TTFT spread without touching any real provider.
     */
    function responseDelay (body = '') {
        if (chatContent(body).trimStart().startsWith('slow')) {
            return 3000 + Math.floor(Math.random() * 3001) // 3000–6000ms
        }
        return 1 + Math.floor(Math.random() * 100) // 1–100ms

        function chatContent (body) {
            try {
                const parsed = JSON.parse(body)
                const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
                for (let i = messages.length - 1; i >= 0; i--) {
                    const content = messages[i]?.content
                    if (typeof content === 'string') return content
                }
            } catch {
                // Not JSON (or empty) — falls through to the default delay.
            }
            return ''
        }
    }
}

// Standalone entry: start the backend and write the matching config file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const mockPort = Number(process.argv[2] ?? process.env.MOCK_PORT ?? DEFAULT_MOCK_PORT)
    const crPort = Number(process.env.CR_PORT ?? DEFAULT_CR_PORT)
    const configPath = join(dirname(fileURLToPath(import.meta.url)), 'mock-server.config.json')
    writeFileSync(configPath, JSON.stringify(mockConfig(mockPort, crPort), null, 4) + '\n')
    const {port} = await startMockServer(mockPort)
    console.log(`mock backend on http://127.0.0.1:${port}`)
    console.log(`closerouter config -> ${configPath}`)
}
