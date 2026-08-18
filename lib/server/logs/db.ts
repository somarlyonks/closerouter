// Usage persistence on top of lib/db: one row per routed model request,
// recorded when the client response closes. Recording never throws into the
// server - a broken storage backend logs and drops the row.

import {sqliteAvailable, run} from '../../db'

export interface UsageEntry {
    ts: number
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
}

let initialized = false

/** Create the usage table if the db is available; safe to call any time. */
export function initUsage (): void {
    if (!sqliteAvailable()) return
    run(`CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
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
        cached_tokens INTEGER
    )`)
    run('CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts)')
    initialized = true
}

export function recordUsage (entry: UsageEntry): void {
    if (!initialized) return
    try {
        run(
            'INSERT INTO usage (ts, method, path, provider, model, status, duration_ms, ttft_ms, generation_ms, input_tokens, output_tokens, cached_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                entry.ts,
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
            ],
        )
    } catch (e) {
        console.error('usage insert failed:', e instanceof Error ? e.message : String(e))
    }
}
