import {test} from 'node:test'
import assert from 'node:assert/strict'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
    sqliteAvailable, openDatabase, closeDatabase, run, all, get,
    messageCollector, encodeParams, decodeValue,
} from '../lib/db'
import {initUsage, recordUsage, loadUsage} from '../lib/server/logs/db'

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
        openDatabase('')
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
        openDatabase('')
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
        openDatabase('')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB)')
        run('INSERT INTO t (data) VALUES (?)', [new Uint8Array([0xde, 0xad, 0xbe, 0xaf])])
        const row = get('SELECT data FROM t')
        assert.equal(Buffer.from(row?.data as Uint8Array).toString('hex'), 'deadbeaf')
    })

    test('get returns the first row or undefined', () => {
        openDatabase('')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
        assert.ok(get('SELECT * FROM t') === undefined)
        run('INSERT INTO t VALUES (1)')
        run('INSERT INTO t VALUES (2)')
        const first = get('SELECT id FROM t ORDER BY id')
        assert.equal(first?.id as number, 1)
        assert.equal(all('SELECT id FROM t ORDER BY id').length, 2)
    })

    test('errors carry the sqlite message', () => {
        openDatabase('')
        assert.throws(() => all('SELECT * FROM nope'), /no such table/)
        assert.throws(() => run('UPDATE nope SET id = 1'), /no such table/)
    })

    test('batch statements run in one call', () => {
        openDatabase('')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)')
        assert.equal(all('SELECT COUNT(*) AS n FROM t')[0].n as number, 2)
    })

    test('changes tracks the last statement', () => {
        openDatabase('')
        run('CREATE TABLE t (id INTEGER PRIMARY KEY)')
        run('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)')
        const deleted = run('DELETE FROM t WHERE id <= ?', [2])
        assert.equal(deleted.changes, 2)
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
        openDatabase('')
        initUsage()
        recordUsage({
            id: 'req-1',
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
        recordUsage({id: 'req-2', time: 5678, method: 'POST', path: '/v1/responses'})
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
        assert.equal(entries[0].id as string, 'req-1')
        assert.equal(entries[0].requestBody as string, '{"model": "p/m"}')
        assert.equal(entries[0].responseBody as string, '{"choices": []}')
        assert.ok(entries[1].requestBody === undefined)
        // idempotent schema
        initUsage()
        assert.equal(all('SELECT COUNT(*) AS n FROM usage')[0].n as number, 2)
    })
}

if (available) {
    sqlTests()
} else {
    test('SQL suite requires an FFI build (scriptc build test/db.test.ts --ffi native/ffi.json)', () => {
        assert.ok(true)
    })
}
