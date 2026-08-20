// Usage persistence on top of lib/db: one row per routed model request,
// recorded when the client response closes. Recording never throws into the
// server - a broken storage backend logs and drops the row.

import {sqliteAvailable, all, get, run} from '../../db'

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

/** Create the usage table if the db is available; safe to call any time. */
export function initUsage (): void {
    if (!sqliteAvailable()) return
    run(`CREATE TABLE IF NOT EXISTS usage (
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
    run('CREATE INDEX IF NOT EXISTS usage_time ON usage (time)')
    initialized = true
}

export function loadUsage (limit = 500): UsageEntry[] {
    if (!initialized) return []
    try {
        // Inner query keeps only the newest `limit` ids; outer sorts oldest-first
        // so the page renders chronologically with the live SSE stream after it.
        // Bodies are deliberately omitted: each can be up to MAX_BODY (1MB), so
        // shipping them for every row dominates the transfer. The logs page
        // fetches a single entry's body on demand via loadUsageBody.
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

export interface UsageTotals {
    count: number
    inTokens: number
    outTokens: number
    cachedTokens: number
}

/** Sum all persisted usage across every logged request. */
export function getUsageTotals (): UsageTotals | undefined {
    if (!initialized) return undefined
    try {
        return all(
            'SELECT COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS in_tokens, COALESCE(SUM(output_tokens), 0) AS out_tokens, COALESCE(SUM(cached_tokens), 0) AS cached_tokens FROM usage',
        ).map(row => ({
            count: typeof row.count === 'number' ? row.count : 0,
            inTokens: typeof row.in_tokens === 'number' ? row.in_tokens : 0,
            outTokens: typeof row.out_tokens === 'number' ? row.out_tokens : 0,
            cachedTokens: typeof row.cached_tokens === 'number' ? row.cached_tokens : 0,
        }))[0]
    } catch (e) {
        console.error('usage totals failed:', e instanceof Error ? e.message : String(e))
        return undefined
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
