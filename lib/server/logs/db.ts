// Usage persistence on top of lib/db: one row per routed model request,
// recorded when the client response closes. Recording never throws into the
// server - a broken storage backend logs and drops the row.

import {sqliteAvailable, all, get, run, withTransaction, type SqlParam, type SqlRow, type SqlValue} from '../../db'
import type {UsageCounts} from './helper'

export interface UsageEntry extends UsageCounts {
    id?: number
    requestId: string
    time: number
    method: string
    path: string
    provider?: string
    model?: string
    status?: number
    durationMs?: number
    ttftMs?: number
    generationMs?: number
    requestBody?: string
    responseBody?: string
}

let initialized = false

export const SCHEMA_VERSION = 1

const createUsageTable = (): void => {
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
}

function readSchemaVersion (): number {
    const row = get('PRAGMA user_version')
    return typeof row?.user_version === 'number' ? row.user_version : 0
}

function tableExists (name: string): boolean {
    return get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]) !== undefined
}

/** Create or migrate the usage table if the db is available; safe to call any time. */
export function initUsage (): void {
    if (!sqliteAvailable()) return
    const version = readSchemaVersion()
    if (version > SCHEMA_VERSION) {
        throw new Error(`usage db schema version ${version} is newer than this build supports (${SCHEMA_VERSION}); upgrade closerouter`)
    }

    if (!tableExists('usage')) {
        withTransaction(() => {
            createUsageTable()
            run('CREATE INDEX usage_time ON usage (time)')
            run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        })
        initialized = true
        return
    }

    // Forward migration steps upgrade a db stamped at version v to v + 1 and
    // must be idempotent - version 0 predates stamping, so such a db may
    // already carry any later shape. Each step is stamped after it runs, so a
    // failed step leaves the db at its last good version and init resumes
    // there on the next start. (v0 -> v1 is a no-op: the pre-versioning table
    // already matches the current shape.)
    for (let v = version; v < SCHEMA_VERSION; v++) {
        withTransaction(() => {
            run(`PRAGMA user_version = ${v + 1}`)
        })
    }
    run('CREATE INDEX IF NOT EXISTS usage_time ON usage (time)')
    initialized = true
}

/** Stop all usage recording and reads. Called once the underlying database is
 *  closed, so a response 'close' handler firing afterwards can never touch the
 *  dead handle (its row is dropped instead of corrupting state). */
export function closeUsageLog (): void {
    initialized = false
}

/** Row-value coercers shared by every usage read. SQLite hands back loosely
 *  typed columns, so each is narrowed back to its expected JS type. */
const asNum = (v: SqlValue | undefined): number => typeof v === 'number' ? v : 0
const asOptNum = (v: SqlValue | undefined): number | undefined => typeof v === 'number' ? v : undefined
const asStr = (v: SqlValue | undefined): string | undefined => typeof v === 'string' ? v : undefined
const asStr0 = (v: SqlValue | undefined): string => typeof v === 'string' ? v : ''

const USAGE_COLUMNS = 'id, request_id, time, method, path, provider, model, status, duration_ms, ttft_ms, generation_ms, input_tokens, output_tokens, cached_tokens'

function mapUsageRow (row: SqlRow): UsageEntry {
    return {
        id: asOptNum(row.id),
        requestId: asStr0(row.request_id),
        time: asNum(row.time),
        method: asStr0(row.method),
        path: asStr0(row.path),
        provider: asStr(row.provider),
        model: asStr(row.model),
        status: asOptNum(row.status),
        durationMs: asOptNum(row.duration_ms),
        ttftMs: asOptNum(row.ttft_ms),
        generationMs: asOptNum(row.generation_ms),
        inputTokens: asOptNum(row.input_tokens),
        outputTokens: asOptNum(row.output_tokens),
        cachedTokens: asOptNum(row.cached_tokens),
    }
}

export interface UsageLogQuery {
    limit?: number
    offset?: number
    /** Case-insensitive substring matched against method, path, provider,
     *  model and status. */
    search?: string
}

export interface UsageLogPage {
    entries: UsageEntry[]
    /** Rows matching the search, across every page. */
    total: number
}

const LOG_LIMIT_MAX = 1000
const LOG_LIMIT_DEFAULT = 500

/** Single-term case-insensitive substring filter, OR-combined across the
 *  matched columns; shared by the page query and its count. */
function logMatch (search: string | undefined): {clause: string, params: SqlParam[]} {
    const term = search?.trim().toLowerCase()
    if (!term) return {clause: '', params: []}
    const like = `%${term}%`
    return {
        clause: ` WHERE (lower(method) LIKE ? OR lower(path) LIKE ? OR lower(provider) LIKE ? OR lower(model) LIKE ? OR CAST(status AS TEXT) LIKE ?)`,
        params: [like, like, like, like, like],
    }
}

/** One page of history, newest page first: page 0 holds the newest rows. The
 *  page itself is returned oldest-first so callers can prepend rows; total
 *  counts every search match, not just this page. */
export function loadUsage (query: UsageLogQuery = {}): UsageLogPage {
    if (!initialized) return {entries: [], total: 0}
    const limit = Math.min(LOG_LIMIT_MAX, Math.max(1, Math.floor(query.limit ?? LOG_LIMIT_DEFAULT)))
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const {clause, params} = logMatch(query.search)
    try {
        let total = 0
        let entries: UsageEntry[] = []
        // One transaction so the count and the page always see the same rows,
        // even if inserts ever run off this synchronous call path.
        withTransaction(() => {
            total = asNum(get(`SELECT COUNT(*) AS count FROM usage${clause}`, params)?.count)
            entries = all(
                `SELECT ${USAGE_COLUMNS} FROM (SELECT * FROM usage${clause} ORDER BY id DESC LIMIT ? OFFSET ?) ORDER BY id ASC`,
                [...params, limit, offset],
            ).map(mapUsageRow)
        })
        return {entries, total}
    } catch (e) {
        console.error('usage page load failed:', e instanceof Error ? e.message : String(e))
        return {entries: [], total: 0}
    }
}

/** Fetch the stored request/response bodies for one row by its integer id. */
export function loadUsageBody (id: number): {requestBody?: string, responseBody?: string} | undefined {
    if (!initialized) return undefined
    try {
        const row = get('SELECT request_body, response_body FROM usage WHERE id = ?', [id])
        if (!row) return undefined
        return {
            requestBody: asStr(row.request_body),
            responseBody: asStr(row.response_body),
        }
    } catch (e) {
        console.error('usage body load failed:', e instanceof Error ? e.message : String(e))
        return undefined
    }
}

export interface UsageFilters {
    from?: number
    to?: number
    provider?: string
    model?: string
}

export interface UsageBucket {
    bucket: number
    count: number
    inTokens: number
    outTokens: number
    cachedTokens: number
}

export interface UsageSeriesModelPoint {
    bucket: number
    model: string
    count: number
    inTokens: number
    outTokens: number
}

export interface UsageGroup {
    key: string
    count: number
    inTokens: number
    outTokens: number
    cachedTokens: number
}

/** A provider/model combination seen in the usage table. */
export interface UsagePair {
    provider: string
    model: string
}

export interface UsageStats {
    count: number
    inTokens: number
    outTokens: number
    cachedTokens: number
    avgDurationMs: number
    avgTtftMs: number
    errorCount: number
    series: UsageBucket[]
    seriesByModel: UsageSeriesModelPoint[]
    byProvider: UsageGroup[]
    byModel: UsageGroup[]
    providerModels: UsagePair[]
}

const HOUR = 3_600_000
const DAY = 86_400_000

const emptyStats = (): UsageStats => ({
    count: 0, inTokens: 0, outTokens: 0, cachedTokens: 0,
    avgDurationMs: 0, avgTtftMs: 0, errorCount: 0,
    series: [], seriesByModel: [], byProvider: [], byModel: [],
    providerModels: [],
})

/** AND-combined time-range/provider/model filters plus the success-only rule
 *  (4xx client errors are excluded, null status and 5xx kept), shared by every
 *  usage aggregation query. */
function usageWhere (filters: UsageFilters): {clause: string, params: SqlParam[]} {
    const where: string[] = []
    const params: SqlParam[] = []
    if (filters.from !== undefined) {
        where.push('time >= ?')
        params.push(filters.from)
    }
    if (filters.to !== undefined) {
        where.push('time <= ?')
        params.push(filters.to)
    }
    if (filters.provider) {
        where.push('provider = ?')
        params.push(filters.provider)
    }
    if (filters.model) {
        where.push('model = ?')
        params.push(filters.model)
    }
    where.push('(status IS NULL OR status < 400 OR status >= 500)')
    return {clause: ` WHERE ${where.join(' AND ')}`, params}
}

function rowMetrics (row: SqlRow): {count: number, inTokens: number, outTokens: number, cachedTokens: number} {
    return {
        count: asNum(row.count),
        inTokens: asNum(row.in_tokens),
        outTokens: asNum(row.out_tokens),
        cachedTokens: asNum(row.cached_tokens),
    }
}

function collectMetericsByKey (row: SqlRow): UsageGroup {
    const metrics = rowMetrics(row)
    return {...metrics, key: asStr(row.key) ?? '(unknown)'}
}

function collectMetericsByBucket (row: SqlRow): UsageBucket {
    const metrics = rowMetrics(row)
    return {...metrics, bucket: asNum(row.bucket)}
}

export function loadUsageStats (filters: UsageFilters = {}): UsageStats {
    if (!initialized) return emptyStats()
    try {
        const {clause, params} = usageWhere(filters)

        const total = all(
            `SELECT COUNT(*) AS count,
                    COALESCE(SUM(input_tokens), 0) AS in_tokens,
                    COALESCE(SUM(output_tokens), 0) AS out_tokens,
                    COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
                    COALESCE(AVG(duration_ms), 0) AS avg_duration,
                    COALESCE(AVG(ttft_ms), 0) AS avg_ttft,
                    COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS error_count
             FROM usage${clause}`,
            params,
        )[0] ?? {}

        const span = (filters.from !== undefined && filters.to !== undefined) ? filters.to - filters.from : 0
        const bucketMs = span > 0 && span <= 3 * DAY ? HOUR : DAY

        const byProvider = all(
            `SELECT provider AS key, COUNT(*) AS count,
                    COALESCE(SUM(input_tokens), 0) AS in_tokens,
                    COALESCE(SUM(output_tokens), 0) AS out_tokens,
                    COALESCE(SUM(cached_tokens), 0) AS cached_tokens
             FROM usage${clause} GROUP BY provider ORDER BY count DESC`,
            params,
        ).map(collectMetericsByKey)

        const byModel = all(
            `SELECT model AS key, COUNT(*) AS count,
                    COALESCE(SUM(input_tokens), 0) AS in_tokens,
                    COALESCE(SUM(output_tokens), 0) AS out_tokens,
                    COALESCE(SUM(cached_tokens), 0) AS cached_tokens
             FROM usage${clause} GROUP BY model ORDER BY count DESC`,
            params,
        ).map(collectMetericsByKey)

        // All-time provider/model pairs for the filter menus: deliberately
        // ignores from/to and the provider/model filters so an active filter
        // can't shrink the list it was selected from.
        const providerModels = all(
            `SELECT DISTINCT provider, model
             FROM usage
             WHERE provider IS NOT NULL AND model IS NOT NULL
               AND (status IS NULL OR status < 400 OR status >= 500)
             ORDER BY provider, model`,
        ).map(row => ({
            provider: asStr(row.provider) ?? '',
            model: asStr(row.model) ?? '',
        })).filter(p => p.provider !== '' && p.model !== '')

        const {series, seriesByModel} = mergeSeries(
            all(
                `SELECT (time / ?) * ? AS bucket,
                        COUNT(*) AS count,
                        COALESCE(SUM(input_tokens), 0) AS in_tokens,
                        COALESCE(SUM(output_tokens), 0) AS out_tokens,
                        COALESCE(SUM(cached_tokens), 0) AS cached_tokens
                 FROM usage${clause} GROUP BY bucket ORDER BY bucket`,
                [bucketMs, bucketMs, ...params],
            ).map(collectMetericsByBucket),
            all(
                `SELECT (time / ?) * ? AS bucket,
                        COALESCE(model, '(unknown)') AS model,
                        COUNT(*) AS count,
                        COALESCE(SUM(input_tokens), 0) AS in_tokens,
                        COALESCE(SUM(output_tokens), 0) AS out_tokens
                 FROM usage${clause} GROUP BY bucket, model ORDER BY bucket`,
                [bucketMs, bucketMs, ...params],
            ).map(row => ({
                bucket: asNum(row.bucket),
                model: asStr(row.model) ?? '(unknown)',
                count: asNum(row.count),
                inTokens: asNum(row.in_tokens),
                outTokens: asNum(row.out_tokens),
            })),
        )

        return {
            count: asNum(total.count),
            inTokens: asNum(total.in_tokens),
            outTokens: asNum(total.out_tokens),
            cachedTokens: asNum(total.cached_tokens),
            avgDurationMs: Math.round(asNum(total.avg_duration)),
            avgTtftMs: Math.round(asNum(total.avg_ttft)),
            errorCount: asNum(total.error_count),
            series,
            seriesByModel,
            byProvider,
            byModel,
            providerModels,
        }
    } catch (e) {
        console.error('usage stats failed:', e instanceof Error ? e.message : String(e))
        return emptyStats()
    }
}

/** Fold a series longer than 45 buckets into at most 45 groups so charts stay
 *  readable at long spans (e.g. a 1-year custom range yields 365 daily
 *  buckets). Group size = ceil(n / 45), so the group count is
 *  ceil(n / groupSize) <= 45; groups are consecutive runs of the present
 *  buckets, so a group's bucket timestamp is its first member's. seriesByModel
 *  is folded by the same bucket->group mapping so both charts stay in sync. */
function mergeSeries (series: UsageBucket[], seriesByModel: UsageSeriesModelPoint[]): {series: UsageBucket[], seriesByModel: UsageSeriesModelPoint[]} {
    const MAX_BUCKETS = 45
    if (series.length <= MAX_BUCKETS) return {series, seriesByModel}

    const groupSize = Math.ceil(series.length / MAX_BUCKETS)
    const grouped: UsageBucket[] = []
    const groupStartOfBucket = new Map<number, number>()
    for (let i = 0; i < series.length; i++) {
        const src = series[i]
        const gi = Math.floor(i / groupSize)
        const start = grouped.length > gi ? grouped[gi].bucket : src.bucket
        groupStartOfBucket.set(src.bucket, start)
        const g = grouped.length > gi
            ? grouped[gi]
            : {bucket: src.bucket, count: 0, inTokens: 0, outTokens: 0, cachedTokens: 0}
        g.count += src.count
        g.inTokens += src.inTokens
        g.outTokens += src.outTokens
        g.cachedTokens += src.cachedTokens
        grouped[gi] = g
    }

    const groupedByModel = new Map<string, UsageSeriesModelPoint>()
    for (const p of seriesByModel) {
        const start = groupStartOfBucket.get(p.bucket)
        if (start === undefined) continue
        const key = `${start}|${p.model}`
        const g = groupedByModel.get(key)
        if (g === undefined) {
            groupedByModel.set(key, {bucket: start, model: p.model, count: p.count, inTokens: p.inTokens, outTokens: p.outTokens})
        } else {
            g.count += p.count
            g.inTokens += p.inTokens
            g.outTokens += p.outTokens
        }
    }

    return {
        series: grouped,
        seriesByModel: [...groupedByModel.values()].sort((a, b) => a.bucket - b.bucket || a.model.localeCompare(b.model)),
    }
}

/**
 * Sparse per-calendar-day buckets for the heatmap. Same filters as
 * loadUsageStats (AND-combined, success-only). Days with no rows are absent
 * from the result on purpose - the client treats a missing day as zero, so
 * the server never zero-fills. Each bucket's timestamp is the local-midnight
 * epoch ms of its calendar day, computed entirely in SQL so only one row per
 * day crosses the FFI boundary: date(...,'localtime') yields the row's local
 * day, and reinterpreting that day's '00:00' with the 'utc' modifier converts
 * local midnight back to a UTC epoch.
 */
export function loadUsageHeatmap (filters: UsageFilters = {}): UsageBucket[] {
    if (!initialized) return []
    try {
        const {clause, params} = usageWhere(filters)
        return all(
            `SELECT CAST(strftime('%s', date(time / 1000, 'unixepoch', 'localtime') || ' 00:00', 'utc') AS INTEGER) * 1000 AS bucket,
                    COUNT(*) AS count,
                    COALESCE(SUM(input_tokens), 0) AS in_tokens,
                    COALESCE(SUM(output_tokens), 0) AS out_tokens,
                    COALESCE(SUM(cached_tokens), 0) AS cached_tokens
             FROM usage${clause} GROUP BY bucket ORDER BY bucket`,
            params,
        ).map(collectMetericsByBucket)
    } catch (e) {
        console.error('usage heatmap failed:', e instanceof Error ? e.message : String(e))
        return []
    }
}

export function recordUsage (entry: UsageEntry): void {
    if (!initialized) return
    try {
        run(
            'INSERT INTO usage (request_id, time, method, path, provider, model, status, duration_ms, ttft_ms, generation_ms, input_tokens, output_tokens, cached_tokens, request_body, response_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                entry.requestId,
                entry.time,
                entry.method,
                entry.path,
                entry.provider ?? null,
                entry.model ?? null,
                entry.status ?? null,
                entry.durationMs ?? null,
                entry.ttftMs ?? null,
                entry.generationMs ?? null,
                entry.inputTokens ?? null,
                entry.outputTokens ?? null,
                entry.cachedTokens ?? null,
                entry.requestBody ?? null,
                entry.responseBody ?? null,
            ],
        )
    } catch (e) {
        console.error('usage insert failed:', e instanceof Error ? e.message : String(e))
    }
}

const RETENTION_SWEEP_INTERVAL_MS = DAY

/** Nulled bodies leave their pages on the sqlite freelist, so the file keeps
 *  its size until those pages are returned to the OS. A full VACUUM rewrites
 *  the db; enabling auto_vacuum first makes later sweeps able to hand pages
 *  back cheaply via incremental_vacuum instead of another full rewrite. */
function vacuumUsageDb (): void {
    try {
        run('PRAGMA auto_vacuum = INCREMENTAL')
        run('VACUUM')
    } catch (e) {
        console.error('usage db vacuum failed:', e instanceof Error ? e.message : String(e))
    }
}

/** Fraction of the db file sitting on the freelist (0 if unreadable). */
function freelistRatio (): number {
    try {
        const pages = get('PRAGMA page_count')?.page_count
        const free = get('PRAGMA freelist_count')?.freelist_count
        if (typeof pages !== 'number' || typeof free !== 'number' || pages === 0) return 0
        return free / pages
    } catch {
        return 0
    }
}

export function startRetentionSweep (retentionDays: number, intervalMs: number = RETENTION_SWEEP_INTERVAL_MS): {stop: () => void} {
    // 0 turns retention off - the sweep is never armed
    if (retentionDays < 1) return {stop: () => {}}
    if (expireUsageBodies(retentionDays) > 0 || freelistRatio() >= 0.1) vacuumUsageDb()
    const timer = setInterval(() => {
        if (expireUsageBodies(retentionDays) > 0) {
            try {
                run('PRAGMA incremental_vacuum')
            } catch (e) {
                console.error('usage db incremental vacuum failed:', e instanceof Error ? e.message : String(e))
            }
        }
    }, intervalMs)
    timer.unref()
    return {stop: () => clearInterval(timer)}
}

export function expireUsageBodies (maxAgeDays: number): number {
    if (!initialized) return 0
    if (maxAgeDays < 1) return 0 // 0 turns retention off
    try {
        const cutoff = Date.now() - maxAgeDays * DAY
        const {changes} = run('UPDATE usage SET request_body = NULL, response_body = NULL WHERE time < ? AND status = 200 AND (request_body IS NOT NULL OR response_body IS NOT NULL)', [cutoff])
        if (changes > 0) console.log(`cleared bodies on ${changes} usage row(s) older than ${maxAgeDays} days`)
        return changes
    } catch (e) {
        console.error('usage body expiration failed:', e instanceof Error ? e.message : String(e))
        return 0
    }
}
