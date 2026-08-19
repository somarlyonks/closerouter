// Usage persistence on top of lib/db: one row per routed model request,
// recorded when the client response closes. Recording never throws into the
// server - a broken storage backend logs and drops the row.

import {sqliteAvailable, all, run} from '../../db'

export interface UsageEntry {
    id: string
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
        return all(
            'SELECT request_id, time, method, path, provider, model, status, duration_ms, ttft_ms, generation_ms, input_tokens, output_tokens, cached_tokens, request_body, response_body FROM (SELECT * FROM usage ORDER BY id DESC LIMIT ?) ORDER BY id ASC',
            [limit],
        ).map(row => ({
            id: typeof row.request_id === 'string' ? row.request_id : '',
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
            requestBody: typeof row.request_body === 'string' ? row.request_body : undefined,
            responseBody: typeof row.response_body === 'string' ? row.response_body : undefined,
        }))
    } catch (e) {
        console.error('usage load failed:', e instanceof Error ? e.message : String(e))
        return []
    }
}

export function recordUsage (entry: UsageEntry): void {
    if (!initialized) return
    try {
        run(
            'INSERT INTO usage (request_id, time, method, path, provider, model, status, duration_ms, ttft_ms, generation_ms, input_tokens, output_tokens, cached_tokens, request_body, response_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                entry.id,
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
