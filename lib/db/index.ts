// SQLite storage via scriptc's outbound FFI (./shim.c, compiled in place to
// ./shim.o by native/build.ts and bound through native/ffi.json).
//
// The C shim owns the sqlite3 handle (the FFI ABI has no pointer passing) and
// streams results back through a u32 callback: one length word (high bit set
// marks the {"columns":[...]} header) followed by big-endian 4-byte words of
// UTF-8 JSON payload, last word zero-padded.
//
// scriptc 0.0.32 bug workaround: a native call whose result is captured into a
// variable (const rc = sqliteExec(...)) silently loses its FFI binding and
// throws ReferenceError at runtime. Every native call in this module is
// therefore used directly - in an if-condition, as a bare statement, or as a
// nested call argument - never stored in a binding. Keep that pattern here.
//
// Only one connection can be open at a time (the shim keeps a single handle);
// openDatabase() on an already-open database closes the old one first.
// INTEGER values beyond 2^53 lose precision (JSON numbers through f64).

declare function sqliteOpen (path: string): number
declare function sqliteClose (): void
declare function sqliteExec (sql: string, params: string, onWord: (word: number) => void): number
declare function sqliteLastError (onWord: (word: number) => void): void
declare function sqliteChanges (): number
declare function sqliteLastInsertRowid (): number

export type SqlParam = string | number | boolean | null | Uint8Array
export type SqlValue = string | number | null | Uint8Array
export type SqlRow = Record<string, SqlValue>

export interface RunResult {
    changes: number
    lastInsertRowid: number
}

let availability: boolean | undefined

/**
 * True when the native SQLite symbols are bound (built with `scriptc build
 * --ffi`). Under plain node or `scriptc run` the declarations are unbound and
 * calls throw a catchable ReferenceError, which callers can detect here.
 */
export function sqliteAvailable (): boolean {
    if (availability === undefined) {
        try {
            sqliteChanges()
            availability = true
        } catch {
            availability = false
        }
    }
    return availability
}

/** Open (or replace) the single connection. Empty path means in-memory. */
export function openDatabase (path: string): void {
    if (sqliteOpen(path) !== 0) throw new Error(`sqlite open failed: ${lastErrorMessage()}`)
}

export function closeDatabase (): void {
    sqliteClose()
}

/**
 * Run a statement (or ;-separated batch - params then bind to every
 * statement) and return `{changes, lastInsertRowid}` of the last one.
 */
export function run (sql: string, params: SqlParam[] = []): RunResult {
    runSql(sql, params, () => { })

    return {
        changes: sqliteChanges(),
        lastInsertRowid: sqliteLastInsertRowid(),
    }
}

/** Run a query and return all rows as objects keyed by column name. */
export function all (sql: string, params: SqlParam[] = []): SqlRow[] {
    const rows: SqlValue[][] = []
    const columns = runSql(sql, params, row => rows.push(row))
    return rows.map(row => zipRow(columns, row))
}

/** Run a query and return the first row, or undefined when there are none. */
export function get (sql: string, params: SqlParam[] = []): SqlRow | undefined {
    const rows = all(sql, params)
    // scriptc throws RangeError on out-of-bounds indexing where node yields undefined
    return rows.length > 0 ? rows[0] : undefined
}

export function messageCollector (onMessage: (isColumns: boolean, data: Buffer) => void): (word: number) => void {
    let expected = -1
    let isColumns = false
    let buf = Buffer.alloc(64)
    let len = 0
    return (word: number) => {
        if (expected < 0) {
            isColumns = (word & 0x80000000) !== 0
            expected = word & 0x7fffffff
            len = 0
            if (expected === 0) {
                onMessage(isColumns, Buffer.alloc(0))
                expected = -1
            }
            return
        }
        if (len + 4 > buf.length) {
            const grown = Buffer.alloc(Math.max(buf.length * 2, len + 4))
            buf.copy(grown, 0, 0, len)
            buf = grown
        }
        buf.writeUInt32BE(word >>> 0, len)
        len += 4
        if (len >= expected) {
            // copy: subarray would alias the internal buffer, which the next
            // message overwrites
            onMessage(isColumns, Buffer.from(buf.subarray(0, expected)))
            expected = -1
        }
    }
}

function lastErrorMessage (): string {
    let msg = ''
    sqliteLastError(messageCollector((_isColumns, data) => {
        msg = data.toString('utf8')
    }))
    return msg
}

/** One row as the shim emits it (JSON-representable, blobs still {$hex}). */
type RawValue = string | number | null | {$hex: string}

function runSql (sql: string, params: SqlParam[], onRow: (row: SqlValue[]) => void): string[] {
    let columns: string[] = []
    const onWord = messageCollector((isColumns, data) => {
        const parsed = JSON.parse(data.toString('utf8'))
        if (isColumns) columns = (parsed as {columns: string[]}).columns
        else onRow((parsed as RawValue[]).map(decodeValue))
    })
    if (sqliteExec(sql, encodeParams(params), onWord) !== 0) {
        throw new Error(`sqlite: ${lastErrorMessage()}`)
    }
    return columns
}

function zipRow (columns: string[], values: SqlValue[]): SqlRow {
    const row: SqlRow = {}
    for (let i = 0; i < columns.length; i++) row[columns[i]] = values[i]
    return row
}

export function decodeValue (value: RawValue): SqlValue {
    // Uint8Array is the only object in RawValue's object branch
    if (value !== null && typeof value === 'object') return Buffer.from(value.$hex, 'hex')
    return value
}

export function encodeParams (params: SqlParam[]): string {
    return JSON.stringify(params.map(encodeParam))
}

function encodeParam (param: SqlParam): string | number | boolean | null | {$hex: string} {
    // Uint8Array is the only object in SqlParam, so a typeof check narrows it
    if (param !== null && typeof param === 'object') {
        return {$hex: Buffer.from(param).toString('hex')}
    }
    return param
}
