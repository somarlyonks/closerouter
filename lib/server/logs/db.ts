// Usage persistence on top of lib/db: one row per routed model request,
// recorded when the client response closes. Recording never throws into the
// server - a broken storage backend logs and drops the row.

import {sqliteAvailable, all, get, run, withTransaction, type SqlParam} from '../../db'

export interface UsageEntry {
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
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    requestBody?: string
    responseBody?: string
}

let initialized = false

export const SCHEMA_VERSION = 1

/** Forward migration steps: `migrations[v]` upgrades a database stamped at
 *  schema version v to v + 1, and must be idempotent - version 0 predates
 *  stamping, so such a db may already carry any later shape. Each step is
 *  followed by stamping its target version, so a failed step leaves the db at
 *  its last good version and init resumes there on the next start. */
const migrations: Array<() => void> = [
    // v0 -> v1: the pre-versioning table already matches the current shape -
    // nothing to change, the stamp below records it as current.
    () => { },
]

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

    for (let v = version; v < SCHEMA_VERSION; v++) {
        withTransaction(() => {
            migrations[v]()
            run(`PRAGMA user_version = ${v + 1}`)
        })
    }
    run('CREATE INDEX IF NOT EXISTS usage_time ON usage (time)')
    initialized = true
}

export function loadUsage (limit = 500): UsageEntry[] {
    if (!initialized) return []
    try {
        return all(
            'SELECT id, request_id, time, method, path, provider, model, status, duration_ms, ttft_ms, generation_ms, input_tokens, output_tokens, cached_tokens FROM (SELECT * FROM usage ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
            [limit],
        ).map(row => ({
            id: typeof row.id === 'number' ? row.id : undefined,
            requestId: typeof row.request_id === 'string' ? row.request_id : '',
            time: typeof row.time === 'number' ? row.time : 0,
            method: typeof row.method === 'string' ? row.method : '',
            path: typeof row.path === 'string' ? row.path : '',
            provider: typeof row.provider === 'string' ? row.provider : undefined,
            model: typeof row.model === 'string' ? row.model : undefined,
            status: typeof row.status === 'number' ? row.status : undefined,
            durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : undefined,
            ttftMs: typeof row.ttft_ms === 'number' ? row.ttft_ms : undefined,
            generationMs: typeof row.generation_ms === 'number' ? row.generation_ms : undefined,
            inputTokens: typeof row.input_tokens === 'number' ? row.input_tokens : undefined,
            outputTokens: typeof row.output_tokens === 'number' ? row.output_tokens : undefined,
            cachedTokens: typeof row.cached_tokens === 'number' ? row.cached_tokens : undefined,
        }))
    } catch (e) {
        console.error('usage load failed:', e instanceof Error ? e.message : String(e))
        return []
    }
}

/** Fetch the stored request/response bodies for one row by its integer id. */
export function loadUsageBody (id: number): {requestBody?: string, responseBody?: string} | undefined {
    if (!initialized) return undefined
    try {
        const row = get('SELECT request_body, response_body FROM usage WHERE id = ?', [id])
        if (!row) return undefined
        return {
            requestBody: typeof row.request_body === 'string' ? row.request_body : undefined,
            responseBody: typeof row.response_body === 'string' ? row.response_body : undefined,
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
}

const HOUR = 3_600_000
const DAY = 86_400_000

const emptyStats = (): UsageStats => ({
    count: 0, inTokens: 0, outTokens: 0, cachedTokens: 0,
    avgDurationMs: 0, avgTtftMs: 0, errorCount: 0,
    series: [], seriesByModel: [], byProvider: [], byModel: [],
})

const asNum = (v: SqlParam): number => typeof v === 'number' ? v : 0
const asStr = (v: SqlParam): string | undefined => typeof v === 'string' ? v : undefined

/** Local-midnight epoch ms for a timestamp, in the server's local timezone.
 *  getTimezoneOffset() is per-instant (DST-aware); scriptc has no lowering for
 *  the local-time `new Date(y, m, d)` constructor, so we avoid it. */
function localMidnightEpoch (ms: number): number {
    const offset = new Date(ms).getTimezoneOffset() * 60_000
    return Math.floor((ms - offset) / DAY) * DAY + offset
}

/** Aggregate usage rows into totals, a time series, and per-provider/model breakdowns.
 *  Filters are AND-combined. Bucket width is hourly for spans <= 3 days, daily otherwise;
 *  series longer than 45 buckets are merged into consecutive groups of ceil(n / 45)
 *  buckets (so at most ceil(n / groupSize) <= 45 groups) so charts stay readable and smooth. */
export function loadUsageStats (filters: UsageFilters = {}): UsageStats {
    if (!initialized) return emptyStats()
    try {
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
        const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

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

        const series = all(
            `SELECT (time / ?) * ? AS bucket,
                    COUNT(*) AS count,
                    COALESCE(SUM(input_tokens), 0) AS in_tokens,
                    COALESCE(SUM(output_tokens), 0) AS out_tokens,
                    COALESCE(SUM(cached_tokens), 0) AS cached_tokens
             FROM usage${clause} GROUP BY bucket ORDER BY bucket`,
            [bucketMs, bucketMs, ...params],
        ).map(row => ({
            bucket: asNum(row.bucket),
            count: asNum(row.count),
            inTokens: asNum(row.in_tokens),
            outTokens: asNum(row.out_tokens),
            cachedTokens: asNum(row.cached_tokens),
        }))

        const byProvider = all(
            `SELECT provider AS key, COUNT(*) AS count,
                    COALESCE(SUM(input_tokens), 0) AS in_tokens,
                    COALESCE(SUM(output_tokens), 0) AS out_tokens,
                    COALESCE(SUM(cached_tokens), 0) AS cached_tokens
             FROM usage${clause} GROUP BY provider ORDER BY count DESC`,
            params,
        ).map(row => ({
            key: asStr(row.key) ?? '(unknown)',
            count: asNum(row.count),
            inTokens: asNum(row.in_tokens),
            outTokens: asNum(row.out_tokens),
            cachedTokens: asNum(row.cached_tokens),
        }))

        const byModel = all(
            `SELECT model AS key, COUNT(*) AS count,
                    COALESCE(SUM(input_tokens), 0) AS in_tokens,
                    COALESCE(SUM(output_tokens), 0) AS out_tokens,
                    COALESCE(SUM(cached_tokens), 0) AS cached_tokens
             FROM usage${clause} GROUP BY model ORDER BY count DESC`,
            params,
        ).map(row => ({
            key: asStr(row.key) ?? '(unknown)',
            count: asNum(row.count),
            inTokens: asNum(row.in_tokens),
            outTokens: asNum(row.out_tokens),
            cachedTokens: asNum(row.cached_tokens),
        }))

        const seriesByModel = all(
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
        }))

        // Merge the series down to at most 45 groups so charts stay readable at
        // long spans (e.g. a 1-year custom range yields 365 daily buckets).
        // Group size = ceil(n / 45); group count = ceil(n / groupSize) <= 45.
        // The group's bucket timestamp is its first member's, and seriesByModel
        // follows the same grouping so both charts stay in sync.
        const MAX_BUCKETS = 45
        let seriesOut = series
        let seriesByModelOut = seriesByModel
        if (series.length > MAX_BUCKETS) {
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
            seriesOut = grouped
            seriesByModelOut = [...groupedByModel.values()].sort((a, b) => a.bucket - b.bucket || a.model.localeCompare(b.model))
        }

        return {
            count: asNum(total.count),
            inTokens: asNum(total.in_tokens),
            outTokens: asNum(total.out_tokens),
            cachedTokens: asNum(total.cached_tokens),
            avgDurationMs: Math.round(asNum(total.avg_duration)),
            avgTtftMs: Math.round(asNum(total.avg_ttft)),
            errorCount: asNum(total.error_count),
            series: seriesOut,
            seriesByModel: seriesByModelOut,
            byProvider,
            byModel,
        }
    } catch (e) {
        console.error('usage stats failed:', e instanceof Error ? e.message : String(e))
        return emptyStats()
    }
}

/**
 * Sparse per-calendar-day buckets for the heatmap. Same filters as
 * loadUsageStats (AND-combined, success-only). Days with no rows are absent
 * from the result on purpose - the client treats a missing day as zero, so
 * the server never zero-fills. Each bucket's timestamp is the local-midnight
 * epoch ms of its calendar day. Rows are bucketed in JS because SQLite's
 * local-tz date helpers return strings that scriptc can't round-trip.
 */
export function loadUsageHeatmap (filters: UsageFilters = {}): UsageBucket[] {
    if (!initialized) return []
    try {
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
        const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

        const rows = all(
            `SELECT time, input_tokens, output_tokens, cached_tokens FROM usage${clause}`,
            params,
        )
        const byDay = new Map<number, UsageBucket>()
        for (const row of rows) {
            const day = localMidnightEpoch(asNum(row.time))
            const b = byDay.get(day) ?? {bucket: day, count: 0, inTokens: 0, outTokens: 0, cachedTokens: 0}
            b.count++
            b.inTokens += asNum(row.input_tokens)
            b.outTokens += asNum(row.output_tokens)
            b.cachedTokens += asNum(row.cached_tokens)
            byDay.set(day, b)
        }
        return [...byDay.values()].sort((a, b) => a.bucket - b.bucket)
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

export function startRetentionSweep (retentionDays: number, intervalMs: number = RETENTION_SWEEP_INTERVAL_MS): {stop: () => void} {
    // 0 turns retention off - the sweep is never armed
    if (retentionDays < 1) return {stop: () => {}}
    expireUsageBodies(retentionDays)
    const timer = setInterval(() => expireUsageBodies(retentionDays), intervalMs)
    timer.unref()
    return {stop: () => clearInterval(timer)}
}

export function expireUsageBodies (maxAgeDays: number): void {
    if (!initialized) return
    if (maxAgeDays < 1) return // 0 turns retention off
    try {
        const cutoff = Date.now() - maxAgeDays * DAY
        const {changes} = run('UPDATE usage SET request_body = NULL, response_body = NULL WHERE time < ? AND status = 200 AND (request_body IS NOT NULL OR response_body IS NOT NULL)', [cutoff])
        if (changes > 0) console.log(`cleared bodies on ${changes} usage row(s) older than ${maxAgeDays} days`)
    } catch (e) {
        console.error('usage body expiration failed:', e instanceof Error ? e.message : String(e))
    }
}
