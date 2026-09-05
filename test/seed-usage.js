// Regenerate the persisted test/test.db usage data for developing the
// Analytics/Logs views: POSTs `--seed N` real chat completions through a
// closerouter server and optionally backfills `--days` of historical rows
// directly into the SQLite db (via node:sqlite) so date-range and
// provider/model filters have data.
//
//   node test/seed-usage.js --seed 20 --backfill
//   npm run test:seed
//
// Starts the mock backend + closerouter server (leaving them running on
// :9999 / :6799) if they aren't already up. The committed test/test.db ships
// pre-seeded, so this is only needed to refresh or vary the baseline.

import {writeFileSync} from 'fs'
import {dirname, join} from 'path'
import {fileURLToPath} from 'url'
import {mockConfig, startMockServer} from './mock-server.js'

const KEY = 'sk-cr-testkey123'
const DEFAULT_MOCK_PORT = 9999
const DEFAULT_CR_PORT = 6799
const SEED_MODELS = ['mock/mock-1', 'mock/mock-2', 'mock2/mock-1']

const args = process.argv.slice(2)
const seedIdx = args.indexOf('--seed')
const seedCount = seedIdx >= 0 ? Number(args[seedIdx + 1]) : undefined
const backfill = args.includes('--backfill')
const daysIdx = args.indexOf('--days')
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : 60
const mockPort = Number(process.env.MOCK_PORT ?? DEFAULT_MOCK_PORT)
const crPort = Number(process.env.CR_PORT ?? DEFAULT_CR_PORT)

const configPath = join(dirname(fileURLToPath(import.meta.url)), 'mock-server.config.json')
const dbPath = join(dirname(configPath), 'test.db')

/** Ensure the mock backend is answering on `port`. */
async function ensureMock (port) {
    const up = await fetch(`http://127.0.0.1:${port}/v1/models`).then(r => r.ok).catch(() => false)
    if (up) return
    await startMockServer(port)
}

/** Start the bundled closerouter against `configPath` if nothing answers on the port. */
async function ensureServer (port, configPath) {
    const up = await fetch(`http://127.0.0.1:${port}/status`).then(r => r.ok).catch(() => false)
    if (up) return null
    const {spawn} = await import('node:child_process')
    const binary = join(dirname(configPath), '..', 'dist', 'closerouter')
    // stdio ignored so this script can exit while the server keeps running
    const proc = spawn(binary, ['server', '-c', configPath], {stdio: 'ignore', detached: true})
    proc.unref()
    for (let i = 0; i < 50; i++) {
        const ok = await fetch(`http://127.0.0.1:${port}/status`).then(r => r.ok).catch(() => false)
        if (ok) return proc
        await new Promise(r => setTimeout(r, 200))
    }
    return proc
}

/** POST `count` chat completions through the running closerouter server. */
async function seedChatCompletions (count, port) {
    for (let i = 0; i < count; i++) {
        const model = SEED_MODELS[i % SEED_MODELS.length]
        await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            method: 'POST',
            headers: {Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json'},
            body: JSON.stringify({model, messages: [{role: 'user', content: `seed ${i + 1}`}]}),
        }).catch(() => {})
        await new Promise(r => setTimeout(r, 30))
    }
}

/** Insert ~`days` of synthetic usage rows directly into the SQLite db. */
async function backfillUsage (dbPath, days) {
    const {DatabaseSync} = await import('node:sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, time INTEGER NOT NULL,
        method TEXT NOT NULL, path TEXT NOT NULL, provider TEXT, model TEXT, status INTEGER,
        duration_ms INTEGER, ttft_ms INTEGER, generation_ms INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
        request_body TEXT, response_body TEXT)`)
    const insert = db.prepare(`INSERT INTO usage
        (request_id, time, method, path, provider, model, status, duration_ms, ttft_ms, generation_ms, input_tokens, output_tokens, cached_tokens, request_body, response_body)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const now = Date.now()
    const DAY = 86_400_000
    let n = 0
    for (let day = days; day >= 0; day--) {
        const perDay = 1 + Math.floor(Math.random() * 4) // 1-4 requests/day
        for (let i = 0; i < perDay; i++) {
            const time = now - day * DAY - Math.floor(Math.random() * DAY)
            const provider = Math.random() < 0.7 ? 'mock' : 'mock2'
            const model = provider === 'mock' ? (Math.random() < 0.6 ? 'mock-1' : 'mock-2') : 'mock-1'
            const inTok = 20 + Math.floor(Math.random() * 400)
            const outTok = 5 + Math.floor(Math.random() * 150)
            const status = Math.random() < 0.05 ? 500 : 200
            const ttft = Math.floor(Math.random() * 600)
            insert.run(
                `seed-backfill-${n++}`, time, 'POST', '/v1/chat/completions', provider, model, status,
                ttft + Math.floor(Math.random() * 3000), ttft, Math.floor(Math.random() * 3000),
                inTok, outTok, Math.floor(inTok * Math.random()),
                `{"model":"${provider}/${model}","messages":[]}`, '{"choices":[]}',
            )
        }
    }
    db.close()
    return n
}

// Write the persistent config, ensure mock + server, then seed/backfill.
writeFileSync(configPath, JSON.stringify(mockConfig(mockPort, crPort, 'test.db'), null, 4) + '\n')
await ensureMock(mockPort)
const proc = await ensureServer(crPort, configPath)
if (proc) console.log(`closerouter server started (pid ${proc.pid}) on :${crPort}`)

if (seedCount) await seedChatCompletions(seedCount, crPort)
if (backfill) {
    const n = await backfillUsage(dbPath, days)
    console.log(`backfilled ${n} historical usage rows`)
}

const stats = await fetch(`http://127.0.0.1:${crPort}/usage`, {
    headers: {Authorization: `Bearer ${KEY}`},
}).then(r => r.json()).catch(() => null)
if (stats) {
    console.log(`usage total: ${stats.count} requests, ${stats.inTokens} in / ${stats.outTokens} out`)
    console.log(`byProvider: ${stats.byProvider.map(g => `${g.key}=${g.count}`).join(', ') || '(none)'}`)
    console.log(`byModel: ${stats.byModel.map(g => `${g.key}=${g.count}`).join(', ') || '(none)'}`)
}
process.exit(0)
