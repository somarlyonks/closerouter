import {createServer, IncomingMessage, Server, ServerResponse} from 'http'
import {createServer as createNetServer, type AddressInfo} from 'net'
import {once} from 'events'
import {mkdtemp, writeFile, rm} from 'fs/promises'
import {tmpdir} from 'os'
import {join} from 'path'
import type {RuntimeConfig} from '../lib/config'
import type {RequestContext, RequestHandler} from '../lib/util'
import {startServer} from '../lib/server'

export class ExitError extends Error {
    readonly code: number
    constructor (code: number) {
        super(`process.exit(${code}) called`)
        this.name = 'ExitError'
        this.code = code
    }
}

export interface ExitResult<T> {
    result?: T
    exit?: {code: number}
    stderr: string
    stdout: string
}

// Runs `fn` with `process.exit` intercepted so that calls to `exitFor`/`process.exit`
// inside `loadConfig` and friends throw an `ExitError` instead of terminating the
// process, and `console.error`/`console.log` output is captured.
export function captureExit<T> (fn: () => T): ExitResult<T> {
    const origExit = process.exit
    const origErr = console.error
    const origLog = console.log
    let stderr = ''
    let stdout = ''
    let exit: {code: number} | undefined

    process.exit = ((code?: number) => {
        exit = {code: code ?? 0}
        throw new ExitError(code ?? 0)
    }) as typeof process.exit
    console.error = (...args: unknown[]) => {
        stderr += args.map(stringify).join(' ') + '\n'
    }
    console.log = (...args: unknown[]) => {
        stdout += args.map(stringify).join(' ') + '\n'
    }

    let result: T | undefined
    try {
        result = fn()
    } catch (e) {
        if (!(e instanceof ExitError)) {
            throw e
        }
    } finally {
        process.exit = origExit
        console.error = origErr
        console.log = origLog
    }
    return {result, exit, stderr, stdout}
}

function stringify (a: unknown): string {
    return typeof a === 'string' ? a : String(a)
}

export interface MockBackendRequest {
    method: string
    url: string
    headers: IncomingMessage['headers']
    body: string
}

export interface MockBackend {
    baseUrl: string
    close: () => Promise<void>
    requests: MockBackendRequest[]
}

export function startMockBackend (
    handler?: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<MockBackend> {
    const requests: MockBackendRequest[] = []
    const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8')
            requests.push({method: req.method ?? '', url: req.url ?? '', headers: req.headers, body})
            if (handler) {
                handler(req, res, body)
            } else {
                res.writeHead(204)
                res.end()
            }
        })
    })
    return new Promise((resolve, reject) => {
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as AddressInfo).port
            resolve({
                baseUrl: `http://127.0.0.1:${port}`,
                close: () => new Promise<void>(r => server.close(() => r())),
                requests,
            })
        })
    })
}

export interface HandlerServer {
    port: number
    close: () => Promise<void>
}

export function startHandlerServer (
    handler: RequestHandler,
    env: RequestContext['env'],
): Promise<HandlerServer> {
    const server = createServer((req, res) => {
        const ctx: RequestContext = {req, env}
        handler(ctx, res)
    })
    return new Promise((resolve, reject) => {
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => resolve({
            port: (server.address() as AddressInfo).port,
            close: () => new Promise<void>(r => server.close(() => r())),
        }))
    })
}

export async function getFreePort (): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createNetServer()
        srv.on('error', reject)
        srv.listen(0, '127.0.0.1', () => {
            const port = (srv.address() as AddressInfo).port
            srv.close(() => resolve(port))
        })
    })
}

export async function writeTempFile (raw: string): Promise<{path: string, cleanup: () => Promise<void>}> {
    const dir = await mkdtemp(join(tmpdir(), 'cr-test-'))
    const configPath = join(dir, 'closerouter.json')
    await writeFile(configPath, raw)
    return {path: configPath, cleanup: () => rm(dir, {recursive: true, force: true})}
}

export async function writeTempConfig (cfg: unknown): Promise<{path: string, cleanup: () => Promise<void>}> {
    return writeTempFile(JSON.stringify(cfg, undefined, 4))
}

export async function startCrServer (config: RuntimeConfig): Promise<{port: number, close: () => Promise<void>}> {
    const server: Server = startServer(config)
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    return {port, close: () => new Promise<void>(r => server.close(() => r()))}
}

export function sampleConfig (over: Partial<RuntimeConfig> = {}): RuntimeConfig {
    return {
        path: over.path ?? '',
        port: over.port ?? 6712,
        key: over.key ?? 'sk-test',
        providers: over.providers ?? {
            p: {base_url: 'http://127.0.0.1:1', api_key: 'p-key', models: [{id: 'm'}]},
        },
    }
}

export interface CapturedResponse {
    statusCode?: number
    headers: Record<string, string>
    body: string
    ended: boolean
    headersSent: boolean
}

export interface MockResponse extends ServerResponse {
    captured: CapturedResponse
}

export function mockRes (): MockResponse {
    const captured: CapturedResponse = {
        statusCode: undefined,
        headers: {},
        body: '',
        ended: false,
        headersSent: false,
    }
    const res = {
        captured,
        get statusCode () {return captured.statusCode},
        set statusCode (v: number | undefined) {captured.statusCode = v},
        get headersSent () {return captured.headersSent},
        writeHead (status: number, headers?: Record<string, string>) {
            captured.statusCode = status
            captured.headersSent = true
            if (headers) {
                for (const [k, v] of Object.entries(headers)) captured.headers[k.toLowerCase()] = String(v)
            }
        },
        write (chunk: string | Buffer) {
            captured.body += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        },
        end (chunk?: string | Buffer) {
            if (chunk !== undefined) {
                captured.body += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
            }
            captured.ended = true
        },
    } as unknown as MockResponse
    return res
}

export function mockReq (opts: {method?: string, url?: string, headers?: Record<string, string>} = {}): IncomingMessage {
    return {
        method: opts.method ?? 'GET',
        url: opts.url ?? '/',
        headers: opts.headers ?? {},
    } as unknown as IncomingMessage
}

export function delay (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
