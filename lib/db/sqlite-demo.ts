// PoC for lib/db through scriptc FFI:
//   node native/build.ts
//   npx scriptc build lib/db/sqlite-demo.ts --ffi native/ffi.json -o dist/sqlite-demo
//   ./dist/sqlite-demo

import {sqliteAvailable, openDatabase, closeDatabase, run, all, get, type SqlRow, type SqlValue} from './index'

function show (value: SqlValue | undefined): string {
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (typeof value === 'object') return '0x' + Buffer.from(value).toString('hex')
    if (typeof value === 'string') return value
    return `${value as number}`
}

function showRow (row: SqlRow | undefined): string {
    if (row === undefined) return 'undefined'
    const parts: string[] = []
    for (const key of Object.keys(row)) parts.push(`${key}=${show(row[key])}`)
    return parts.join(' ')
}

if (!sqliteAvailable()) throw new Error('sqlite FFI not bound - build with --ffi')

openDatabase('') // in-memory
run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, data BLOB)')
run('INSERT INTO t (name, score, data) VALUES (?, ?, ?)', ['al"ice\n🐱', 1.5, new Uint8Array([0xde, 0xad])])
run('INSERT INTO t (name, score) VALUES (?, ?)', [null, 2])

const rows = all('SELECT id, name, score, data FROM t ORDER BY id')
console.log('row 1:', showRow(rows[0]))
console.log('row 2:', showRow(rows[1]))
console.log('delete:', run('DELETE FROM t WHERE id = ?', [1]))
console.log('count:', show(get('SELECT COUNT(*) AS n FROM t')?.n))

try {
    all('SELECT * FROM nope')
} catch (e) {
    console.log('expected error ->', (e as Error).message)
}

closeDatabase()
console.log('lib/db via scriptc FFI OK')
