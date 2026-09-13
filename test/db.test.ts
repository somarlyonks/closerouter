import {test} from 'node:test'
import assert from 'node:assert/strict'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'http'
import {
    sqliteAvailable, openDatabase, closeDatabase, run, all, get, withTransaction,
    messageCollector, encodeParams, decodeValue,
} from '../lib/db'
import {initUsage, recordUsage, loadUsage, loadUsageBody, loadUsageStats, expireUsageBodies, startRetentionSweep, SCHEMA_VERSION} from '../lib/server/logs/db'
import {handleStatus} from '../lib/server/status'
import type {RuntimeConfig} from '../lib/config'

/** Minimal RuntimeConfig for the /status handler test - the handler only reads dbPath. */
function statusConfig (dbPath: string | undefined): RuntimeConfig {
    return {port: 0, key: 'k', dbPath, retentionDays: 7, providers: {}}
}

// The SQL tests need the native SQLite symbols, which only exist when this
// file is compiled by scriptc with --ffi, e.g.
//   npx scriptc build test/db.test.ts --ffi native/ffi.json -o dist/db-test
// Under plain `npm test` they are not registered at all (scriptc only lowers
// literal skip values, so availability gating happens via registration).
const available = sqliteAvailable()

/** Build the shim's wire framing for one message, mirroring deliver() in shim.c. */
function frame (text: string, isColumns: boolean): number[] {
    const bytes = Buffer.from(text, 'utf8')
    const words: number[] = [((isColumns ? 0x80000000 : 0) | bytes.length) >>> 0]
    for (let i = 0; i + 4 <= bytes.length; i += 4) words.push(bytes.readUInt32BE(i))
    const rest = bytes.length % 4
    if (rest) {
        const last = Buffer.alloc(4)
        bytes.copy(last, 0, bytes.length - rest)
        words.push(last.readUInt32BE(0))
    }
    return words
}

function collect (words: number[]): Array<{isColumns: boolean, data: Buffer}> {
    const messages: Array<{isColumns: boolean, data: Buffer}> = []
    const push = messageCollector((isColumns, data) => messages.push({isColumns, data}))
    for (const word of words) push(word)
    return messages
}

test('messageCollector reassembles a columns header', () => {
    const messages = collect(frame('{"columns":["a","b"]}', true))
    assert.equal(messages.length, 1)
    assert.equal(messages[0].isColumns, true)
    assert.equal(messages[0].data.toString('utf8'), '{"columns":["a","b"]}')
})

test('messageCollector reassembles a row without the columns flag', () => {
    const messages = collect(frame('[1,"x",null]', false))
    assert.equal(messages.length, 1)
    assert.equal(messages[0].isColumns, false)
    assert.equal(messages[0].data.toString('utf8'), '[1,"x",null]')
})

test('messageCollector completes a zero-length message immediately', () => {
    const messages = collect([0])
    assert.equal(messages.length, 1)
    assert.equal(messages[0].isColumns, false)
    assert.equal(messages[0].data.length, 0)
})

test('messageCollector strips zero padding from the last word', () => {
    const messages = collect(frame('abcdefg', false)) // 7 bytes -> 2 padded words
    assert.equal(messages.length, 1)
    assert.equal(messages[0].data.length, 7)
    assert.equal(messages[0].data.toString('utf8'), 'abcdefg')
})

test('messageCollector sequences multiple messages back to back', () => {
    const messages = collect([
        ...frame('{"columns":["x"]}', true),
        ...frame('[1]', false),
        ...frame('[2]', false),
    ])
    assert.equal(messages.length, 3)
    assert.deepEqual(messages.map(m => m.isColumns), [true, false, false])
    assert.deepEqual(messages.map(m => m.data.toString('utf8')), ['{"columns":["x"]}', '[1]', '[2]'])
})

test('messageCollector grows past the initial 64-byte buffer', () => {
    const text = 'x'.repeat(300)
    const messages = collect(frame(text, false))
    assert.equal(messages.length, 1)
    assert.equal(messages[0].data.length, 300)
    assert.equal(messages[0].data.toString('utf8'), text)
})

test('encodeParams maps every param kind onto the shim wire format', () => {
    assert.equal(
        encodeParams(['te"xt', 1.5, 3, true, false, null, new Uint8Array([0xde, 0xad])]),
        '["te\\"xt",1.5,3,true,false,null,{"$hex":"dead"}]',
    )
})

test('decodeValue turns {$hex} into bytes and passes scalars through', () => {
    assert.equal(Buffer.from(decodeValue({$hex: 'deadbeaf'}) as Uint8Array).toString('hex'), 'deadbeaf')
    assert.equal(decodeValue('x') as string, 'x')
    assert.equal(decodeValue(1) as number, 1)
    assert.ok(decodeValue(null) === null)
})

/** scriptc 0.0.32 ICEs on `recordProp === null` directly; a param avoids it. */
function isNull (value: unknown): boolean {
    return value === null
}

function sqlTests (): void {
    test('open, insert, and select round-trip', () => {
        openDatabase(':memory:')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL)')
        const inserted = run('INSERT INTO t (name, score) VALUES (?, ?)', ['alice', 1.5])
        assert.equal(inserted.changes, 1)
        assert.equal(inserted.lastInsertRowid, 1)
        const rows = all('SELECT id, name, score FROM t')
        assert.equal(rows.length, 1)
        assert.equal(rows[0].id as number, 1)
        assert.equal(rows[0].name as string, 'alice')
        assert.equal(rows[0].score as number, 1.5)
    })

    test('params bind null, booleans, and text with escapes', () => {
        openDatabase(':memory:')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INTEGER)')
        run('INSERT INTO t (v, n) VALUES (?, ?)', ['a"b\nc🐱', null])
        run('INSERT INTO t (v, n) VALUES (?, ?)', ['plain', true])
        run('INSERT INTO t (v, n) VALUES (?, ?)', ['more', false])
        const rows = all('SELECT id, v, n FROM t ORDER BY id')
        assert.equal(rows.length, 3)
        assert.equal(rows[0].v as string, 'a"b\nc🐱')
        assert.ok(isNull(rows[0].n))
        assert.equal(rows[1].n as number, 1) // true binds as 1
        assert.equal(rows[2].n as number, 0) // false binds as 0
    })

    test('blob params round-trip as bytes', () => {
        openDatabase(':memory:')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)')
        run('INSERT INTO t (data) VALUES (?)', [new Uint8Array([0xde, 0xad, 0xbe, 0xaf])])
        const row = get('SELECT data FROM t')
        assert.equal(Buffer.from(row?.data as Uint8Array).toString('hex'), 'deadbeaf')
    })

    test('get returns the first row or undefined', () => {
        openDatabase(':memory:')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
        assert.ok(get('SELECT * FROM t') === undefined)
        run('INSERT INTO t VALUES (1)')
        run('INSERT INTO t VALUES (2)')
        const first = get('SELECT id FROM t ORDER BY id')
        assert.equal(first?.id as number, 1)
        assert.equal(all('SELECT id FROM t ORDER BY id').length, 2)
    })

    test('errors carry the sqlite message', () => {
        openDatabase(':memory:')
        assert.throws(() => all('SELECT * FROM nope'), /no such table/)
        assert.throws(() => run('UPDATE nope SET id = 1'), /no such table/)
    })

    test('batch statements run in one call', () => {
        openDatabase(':memory:')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)')
        assert.equal(all('SELECT COUNT(*) AS n FROM t')[0].n as number, 2)
    })

    test('changes tracks the last statement', () => {
        openDatabase(':memory:')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
        run('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)')
        const deleted = run('DELETE FROM t WHERE id <= ?', [2])
        assert.equal(deleted.changes, 2)
    })

    test('withTransaction commits a successful action', () => {
        openDatabase(':memory:')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
        withTransaction(() => {
            run('INSERT INTO t VALUES (1)')
            run('INSERT INTO t VALUES (2)')
        })
        assert.equal(all('SELECT COUNT(*) AS n FROM t')[0].n as number, 2)
    })

    test('withTransaction rolls back and rethrows a failed action', () => {
        openDatabase(':memory:')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
        assert.throws(() => withTransaction(() => {
            run('INSERT INTO t VALUES (1)')
            throw new Error('stop transaction')
        }), /stop transaction/)
        assert.equal(all('SELECT COUNT(*) AS n FROM t')[0].n as number, 0)
    })

    test('a file-backed database persists across close and reopen', () => {
        const path = join(tmpdir(), 'closerouter-db-test.db')
        openDatabase(path)
        run('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)')
        run('INSERT OR REPLACE INTO kv VALUES (?, ?)', ['persisted', 'yes'])
        closeDatabase()
        openDatabase(path)
        assert.equal(get('SELECT v FROM kv WHERE k = ?', ['persisted'])?.v as string, 'yes')
        closeDatabase()
    })

    test('usage rows persist through recordUsage', () => {
        openDatabase(':memory:')
        initUsage()
        recordUsage({
            requestId: 'req-1',
            time: 1234,
            method: 'POST',
            path: '/v1/chat/completions',
            provider: 'p',
            model: 'm',
            status: 200,
            durationMs: 42,
            ttftMs: 5,
            generationMs: 30,
            inputTokens: 10,
            outputTokens: 20,
            cachedTokens: 3,
            requestBody: '{"model": "p/m"}',
            responseBody: '{"choices": []}',
        })
        recordUsage({requestId: 'req-2', time: 5678, method: 'POST', path: '/v1/responses'})
        const rows = all('SELECT * FROM usage ORDER BY id')
        assert.equal(rows.length, 2)
        assert.equal(rows[0].request_id as string, 'req-1')
        assert.equal(rows[0].provider as string, 'p')
        assert.equal(rows[0].time as number, 1234)
        assert.equal(rows[0].model as string, 'm')
        assert.equal(rows[0].status as number, 200)
        assert.equal(rows[0].duration_ms as number, 42)
        assert.equal(rows[0].input_tokens as number, 10)
        assert.ok(isNull(rows[0].cached_tokens) === false)
        assert.equal(rows[0].cached_tokens as number, 3)
        assert.equal(rows[0].request_body as string, '{"model": "p/m"}')
        assert.equal(rows[0].response_body as string, '{"choices": []}')
        assert.ok(isNull(rows[1].provider))
        assert.ok(isNull(rows[1].input_tokens))
        assert.ok(isNull(rows[1].request_body))
        assert.ok(isNull(rows[1].response_body))
        const entries = loadUsage()
        assert.equal(entries.length, 2)
        assert.equal(entries[0].requestId as string, 'req-1')
        assert.ok((entries[0].id as number) >= 1)
        assert.ok(entries[0].requestBody === undefined)
        assert.ok(entries[0].responseBody === undefined)
        assert.ok(entries[1].requestBody === undefined)
        // bodies are fetched on demand by integer row id
        const body = loadUsageBody(entries[0].id as number)
        assert.equal(body?.requestBody as string, '{"model": "p/m"}')
        assert.equal(body?.responseBody as string, '{"choices": []}')
        assert.ok(loadUsageBody(entries[1].id as number)?.requestBody === undefined)
        assert.ok(loadUsageBody(-1) === undefined)
        // idempotent schema
        initUsage()
        assert.equal(all('SELECT COUNT(*) AS n FROM usage')[0].n as number, 2)
    })

    test('expireUsageBodies clears bodies on expired successful rows and keeps the rest', () => {
        openDatabase(':memory:')
        initUsage()
        const DAY = 86_400_000
        const now = Date.now()
        const row = (id: string, time: number, status = 200) =>
            recordUsage({requestId: id, time, method: 'POST', path: '/v1/chat/completions', provider: 'p', model: 'm', status, requestBody: `{"req":"${id}"}`, responseBody: `{"res":"${id}"}`})
        row('old', now - 61 * DAY)
        row('old-err', now - 61 * DAY, 500)
        row('mid', now - 31 * DAY)
        row('fresh', now - 1 * DAY)

        expireUsageBodies(60)
        const after = all('SELECT request_id, request_body, response_body FROM usage ORDER BY id')
        // rows are kept - only successful (200) expired bodies are dropped
        assert.deepEqual(after.map(r => r.request_id as string), ['old', 'old-err', 'mid', 'fresh'])
        assert.ok(isNull(after[0].request_body) && isNull(after[0].response_body))
        assert.equal(after[1].request_body as string, '{"req":"old-err"}') // 500 bodies kept
        assert.equal(after[1].response_body as string, '{"res":"old-err"}')
        assert.equal(after[2].request_body as string, '{"req":"mid"}')
        assert.equal(after[3].request_body as string, '{"req":"fresh"}')

        // idempotent - re-running clears nothing new
        const changesBefore = get('SELECT total_changes() AS n')?.n as number
        expireUsageBodies(60)
        assert.equal(get('SELECT total_changes() AS n')?.n as number, changesBefore)
        assert.equal(all('SELECT COUNT(*) AS n FROM usage')[0].n as number, 4)

        // a stricter policy clears the next-oldest successful row's bodies too
        expireUsageBodies(30)
        const stricter = all('SELECT request_id, request_body FROM usage ORDER BY id')
        assert.ok(isNull(stricter[2].request_body))
        assert.equal(stricter[1].request_body as string, '{"req":"old-err"}') // 500 still kept
        assert.equal(stricter[3].request_body as string, '{"req":"fresh"}')
    })

    test('expireUsageBodies keeps newer rows intact through the normal API', () => {
        openDatabase(':memory:')
        initUsage()
        const DAY = 86_400_000
        const now = Date.now()
        recordUsage({requestId: 'old', time: now - 365 * DAY, method: 'POST', path: '/v1/chat/completions', status: 200, requestBody: 'old-body', responseBody: 'old-res'})
        recordUsage({requestId: 'new', time: now, method: 'POST', path: '/v1/chat/completions', status: 200, requestBody: 'new-body', responseBody: 'new-res'})
        expireUsageBodies(90)
        const rows = all('SELECT request_id FROM usage ORDER BY id')
        assert.equal(rows.length, 2) // both rows survive
        assert.equal(loadUsage().length, 2)
        // the expired row's bodies are gone; the fresh row's are still fetchable
        const ids = loadUsage()
        const oldEntry = ids.find(e => e.requestId === 'old')!
        const newEntry = ids.find(e => e.requestId === 'new')!
        assert.ok(loadUsageBody(oldEntry.id as number)?.requestBody === undefined)
        assert.ok(loadUsageBody(oldEntry.id as number)?.responseBody === undefined)
        assert.equal(loadUsageBody(newEntry.id as number)?.requestBody as string, 'new-body')
        assert.equal(loadUsageBody(newEntry.id as number)?.responseBody as string, 'new-res')
    })

    test('startRetentionSweep clears expired bodies periodically without restart', async () => {
        openDatabase(':memory:')
        initUsage()
        const DAY = 86_400_000
        const now = Date.now()
        recordUsage({requestId: 'old', time: now - 200 * DAY, method: 'POST', path: '/v1/chat/completions', status: 200, requestBody: 'big-old', responseBody: 'big-old'})
        recordUsage({requestId: 'err', time: now - 400 * DAY, method: 'POST', path: '/v1/chat/completions', status: 500, requestBody: 'err-body', responseBody: 'err-body'})
        recordUsage({requestId: 'new', time: now, method: 'POST', path: '/v1/chat/completions', status: 200, requestBody: 'small', responseBody: 'small'})

        const sweep = startRetentionSweep(7, 20)
        // the first run is immediate - the expired successful body is cleared before any tick
        const immediately = all('SELECT request_id, request_body FROM usage ORDER BY id')
        assert.ok(isNull(immediately[0].request_body))
        assert.equal(immediately[1].request_body as string, 'err-body') // 500 kept
        assert.equal(immediately[2].request_body as string, 'small')
        await new Promise(r => setTimeout(r, 80)) // several ticks
        sweep.stop()

        const rows = all('SELECT request_id, request_body FROM usage ORDER BY id')
        assert.equal(rows.length, 3)
        assert.ok(isNull(rows[0].request_body)) // expired 200 body cleared by the sweep
        assert.equal(rows[1].request_body as string, 'err-body') // 500 untouched
        assert.equal(rows[2].request_body as string, 'small') // fresh body untouched

        // stopping the sweep leaves newer expired rows alone until the next sweep
        const later = Date.now()
        recordUsage({requestId: 'old2', time: later - 300 * DAY, method: 'POST', path: '/v1/chat/completions', status: 200, requestBody: 'stale', responseBody: 'stale'})
        await new Promise(r => setTimeout(r, 60))
        const rows2 = all('SELECT request_id, request_body FROM usage WHERE request_id = ?', ['old2'])
        assert.equal(rows2[0].request_body as string, 'stale')
    })

    test('retentionDays 0 turns retention off', async () => {
        openDatabase(':memory:')
        initUsage()
        const DAY = 86_400_000
        const now = Date.now()
        recordUsage({requestId: 'old', time: now - 200 * DAY, method: 'POST', path: '/v1/chat/completions', status: 200, requestBody: 'big', responseBody: 'big'})

        // a direct call with 0 clears nothing
        expireUsageBodies(0)
        assert.equal(all('SELECT request_body FROM usage')[0].request_body as string, 'big')

        // a 0-days sweep arms no timer and clears nothing either
        const sweep = startRetentionSweep(0, 20)
        await new Promise(r => setTimeout(r, 60))
        sweep.stop()
        assert.equal(all('SELECT request_body FROM usage')[0].request_body as string, 'big')
    })

    test('GET /status reports the sqlite version only when a db is configured, without disturbing it', async () => {
        closeDatabase() // clean unopened state regardless of prior tests
        const status = async (dbPath: string | undefined): Promise<{sqlite?: string}> => {
            const server = createServer((req, res) => {
                handleStatus({req, env: {config: statusConfig(dbPath)}, responseLog: {}}, res)
            })
            const port = await new Promise<number>((resolve, reject) => {
                server.on('error', reject)
                server.listen(0, '127.0.0.1', () => resolve((server.address() as {port: number}).port))
            })
            try {
                const res = await fetch(`http://127.0.0.1:${port}/status`)
                assert.equal(res.status, 200)
                return await res.json() as {sqlite?: string}
            } finally {
                await new Promise<void>(r => server.close(() => r()))
            }
        }

        // db disabled: nothing reported at all
        assert.ok((await status(undefined)).sqlite === undefined)
        // configured (in-memory or file): the sqlite version is reported, not the path
        assert.match((await status('')).sqlite ?? '', /^\d+\.\d+/)
        assert.match((await status('/tmp/x.db')).sqlite ?? '', /^\d+\.\d+/)

        // a live usage database stays intact across status probes - the probe
        // must query the existing handle, never replace it
        openDatabase(':memory:')
        initUsage()
        recordUsage({requestId: 'probe', time: Date.now(), method: 'POST', path: '/v1/chat/completions', status: 200})
        const countBefore = all('SELECT COUNT(*) AS n FROM usage')[0].n as number
        assert.match((await status('')).sqlite ?? '', /^\d+\.\d+/)
        // the probe wrote nothing and the handle is still the same connection
        assert.equal(all('SELECT COUNT(*) AS n FROM usage')[0].n as number, countBefore)
        recordUsage({requestId: 'after', time: Date.now(), method: 'POST', path: '/v1/chat/completions', status: 200})
        assert.equal(all('SELECT COUNT(*) AS n FROM usage')[0].n as number, countBefore + 1)
    })

    test('initUsage stamps the schema version on a fresh db', () => {
        openDatabase(':memory:')
        assert.equal(get('PRAGMA user_version')?.user_version as number, 0)
        initUsage()
        assert.equal(get('PRAGMA user_version')?.user_version as number, SCHEMA_VERSION)
        assert.equal(all('SELECT COUNT(*) AS n FROM usage')[0].n as number, 0)
    })

    test('initUsage rolls back fresh schema creation when setup fails', () => {
        openDatabase(':memory:')
        run('CREATE TABLE usage_time (id INTEGER PRIMARY KEY)')

        assert.throws(() => initUsage(), /usage_time/)
        assert.equal(get('PRAGMA user_version')?.user_version as number, 0)
        assert.ok(!get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage'`))
    })

    test('initUsage migrates a pre-versioning db forward and preserves its rows', () => {
        openDatabase(':memory:')
        // simulate the historical (pre-stamping) usage schema: current shape, no version stamp
        run(`CREATE TABLE usage (
            id INTEGER PRIMARY KEY,
            request_id TEXT NOT NULL,
            time INTEGER NOT NULL,
            method TEXT NOT NULL,
            path TEXT NOT NULL,
            provider TEXT,
            model TEXT,
            status INTEGER,
            duration_ms INTEGER,
            ttft_ms INTEGER,
            generation_ms INTEGER,
            input_tokens INTEGER,
            output_tokens INTEGER,
            cached_tokens INTEGER,
            request_body TEXT,
            response_body TEXT
        )`)
        run(`INSERT INTO usage (request_id, time, method, path, provider, model, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, ['legacy', 1234, 'POST', '/v1/chat/completions', 'p', 'm', 200])
        assert.equal(get('PRAGMA user_version')?.user_version as number, 0)

        initUsage()

        assert.equal(get('PRAGMA user_version')?.user_version as number, SCHEMA_VERSION)
        const rows = all('SELECT request_id, time, status FROM usage')
        assert.equal(rows.length, 1)
        assert.equal(rows[0].request_id as string, 'legacy')
        assert.equal(rows[0].status as number, 200)
        // anything the current shape requires that the old db may lack is in place
        assert.ok(get(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'usage_time'`))
    })

    test('initUsage re-runs are idempotent - version and rows unchanged', () => {
        openDatabase(':memory:')
        initUsage()
        recordUsage({requestId: 'kept', time: 1, method: 'POST', path: '/v1/x'})
        initUsage()
        initUsage()
        assert.equal(get('PRAGMA user_version')?.user_version as number, SCHEMA_VERSION)
        assert.equal(all('SELECT COUNT(*) AS n FROM usage')[0].n as number, 1)
    })

    test('initUsage refuses a db stamped with a newer schema version', () => {
        openDatabase(':memory:')
        run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
        assert.throws(() => initUsage(), /newer/)
        // refused before any writes - the db stays untouched
        assert.ok(!get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage'`))
    })

    test('loadUsageStats aggregates totals, filters, series and breakdowns', () => {
        openDatabase(':memory:')
        initUsage()
        const DAY = 86_400_000
        const base = Date.now() - 10 * DAY
        const row = (id: string, time: number, provider: string, model: string, status: number, inTok: number, outTok: number) =>
            recordUsage({
                requestId: id, time, method: 'POST', path: '/v1/chat/completions',
                provider, model, status, durationMs: 100, ttftMs: 10,
                inputTokens: inTok, outputTokens: outTok, cachedTokens: Math.floor(inTok / 10),
            })
        row('s1', base, 'p1', 'm1', 200, 10, 20)
        row('s2', base + DAY, 'p1', 'm1', 200, 30, 40)
        row('s3', base + 2 * DAY, 'p2', 'm2', 500, 50, 60)

        const stats = loadUsageStats()
        assert.equal(stats.count, 3)
        assert.equal(stats.inTokens, 90)
        assert.equal(stats.outTokens, 120)
        assert.equal(stats.cachedTokens, 9) // 1 + 3 + 5
        assert.equal(stats.errorCount, 1)
        assert.equal(stats.avgDurationMs, 100)
        assert.equal(stats.series.length, 3) // one row per day-bucket
        assert.equal(stats.byProvider.length, 2)
        assert.equal(stats.byModel.length, 2)
        assert.equal(stats.byProvider[0].key, 'p1') // sorted by count desc
        assert.equal(stats.byProvider[0].count, 2)

        // per-bucket per-model series: m1 spans 2 buckets, m2 1 -> 3 points
        assert.equal(stats.seriesByModel.length, 3)
        const sbm = (bucket: number, model: string) =>
            stats.seriesByModel.find(p => p.bucket === Math.floor(bucket / DAY) * DAY && p.model === model)
        const s1 = sbm(base, 'm1')
        assert.ok(s1)
        assert.equal(s1!.count, 1)
        assert.equal(s1!.inTokens, 10)
        assert.equal(s1!.outTokens, 20)
        assert.ok(sbm(base + DAY, 'm2') === undefined)
        const hourly = loadUsageStats({from: base, to: base + 2 * DAY})
        assert.equal(hourly.series.length, 3)
        assert.equal(hourly.seriesByModel.length, 3) // same buckets, model split preserved

        const p1 = loadUsageStats({provider: 'p1'})
        assert.equal(p1.count, 2)
        assert.equal(p1.inTokens, 40)

        const m2 = loadUsageStats({model: 'm2'})
        assert.equal(m2.count, 1)

        const from = loadUsageStats({from: base + 2 * DAY})
        assert.equal(from.count, 1)

        const to = loadUsageStats({to: base + DAY})
        assert.equal(to.count, 2) // inclusive: s1 and s2

        const range = loadUsageStats({from: base + DAY, to: base + DAY})
        assert.equal(range.count, 1)

        const fromAndProvider = loadUsageStats({from: base, provider: 'p2'})
        assert.equal(fromAndProvider.count, 1)
    })

    test('loadUsageStats merges series beyond 45 buckets', () => {
        openDatabase(':memory:')
        initUsage()
        const DAY = 86_400_000
        const base = Math.floor((Date.now() - 150 * DAY) / DAY) * DAY + 4 * 3_600_000 // day-aligned mid-day
        const row = (id: string, time: number, provider: string, model: string, status: number, inTok: number, outTok: number) =>
            recordUsage({
                requestId: id, time, method: 'POST', path: '/v1/chat/completions',
                provider, model, status, durationMs: 100, ttftMs: 10,
                inputTokens: inTok, outputTokens: outTok, cachedTokens: 0,
            })
        // 120 daily rows across two models, alternating so each model has 60 buckets
        for (let d = 0; d < 120; d++) {
            row(`m${d}`, base + d * DAY, 'p1', d % 2 === 0 ? 'mA' : 'mB', 200, 10, 20)
        }

        const stats = loadUsageStats({from: base - DAY, to: base + 121 * DAY})
        // 120 daily buckets -> group size = ceil(120/45) = 3 -> 40 groups
        assert.equal(stats.series.length, 40)
        assert.equal(stats.series.length, Math.ceil(120 / Math.ceil(120 / 45)))
        // bucket = first member of the group
        assert.equal(stats.series[0].bucket, Math.floor(base / DAY) * DAY)
        assert.equal(stats.series[1].bucket, Math.floor((base + 3 * DAY) / DAY) * DAY)
        // all rows preserved through the merge
        assert.equal(stats.series.reduce((n, b) => n + b.count, 0), 120)
        assert.equal(stats.series.reduce((n, b) => n + b.inTokens, 0), 1200)
        assert.equal(stats.series.reduce((n, b) => n + b.outTokens, 0), 2400)
        // seriesByModel follows the same grouping: 40 groups x 2 models
        assert.equal(stats.seriesByModel.length, 80)
        const pt = (bucket: number, model: string) =>
            stats.seriesByModel.find(p => p.bucket === bucket && p.model === model)
        const g0mA = pt(stats.series[0].bucket, 'mA')
        assert.ok(g0mA)
        assert.equal(g0mA!.count, 2) // days 0 and 2 of the group
        assert.equal(g0mA!.inTokens, 20)
        const g0mB = pt(stats.series[0].bucket, 'mB')
        assert.ok(g0mB)
        assert.equal(g0mB!.count, 1) // day 1
        assert.equal(g0mB!.inTokens, 10)
        // totals survive per-model too
        assert.equal(stats.seriesByModel.reduce((n, p) => n + p.count, 0), 120)
        // short spans are never merged
        const small = loadUsageStats({from: base - DAY, to: base + 2 * DAY})
        assert.equal(small.series.length, 3)
    })

    test('loadUsageStats excludes 4xx responses but keeps null statuses and 5xx', () => {
        openDatabase(':memory:')
        initUsage()
        const DAY = 86_400_000
        const base = Math.floor(Date.now() / DAY) * DAY
        const row = (id: string, time: number, provider: string, model: string, status: number | undefined, inTok: number, outTok: number) =>
            recordUsage({
                requestId: id, time, method: 'POST', path: '/v1/chat/completions',
                provider, model, status, durationMs: 100, ttftMs: 10,
                inputTokens: inTok, outputTokens: outTok, cachedTokens: 0,
            })
        row('ok1', base, 'p1', 'm1', 200, 10, 20)
        row('nf1', base + DAY, 'p1', 'm2', 404, 10, 20)
        row('bad', base + DAY + 1, 'p1', 'm2', 401, 10, 20)
        row('err', base + 2 * DAY, 'p1', 'm1', 500, 10, 20)
        row('null', base + 3 * DAY, 'p1', 'm1', undefined, 10, 20)

        const stats = loadUsageStats({from: base - DAY, to: base + 4 * DAY})
        assert.equal(stats.count, 3) // 200, 500, null — 404 & 401 excluded
        assert.equal(stats.inTokens, 30)
        assert.equal(stats.errorCount, 1) // only the 500; 4xx doesn't pollute errors
        assert.equal(stats.series.length, 3) // 4xx buckets dropped
        assert.equal(stats.byModel.length, 1) // 4xx m2 excluded -> only m1
        assert.equal(stats.seriesByModel.length, 3)
    })
}

if (available) {
    sqlTests()
} else {
    test('SQL suite requires an FFI build (scriptc build test/db.test.ts --ffi native/ffi.json)', () => {
        assert.ok(true)
    })
}
