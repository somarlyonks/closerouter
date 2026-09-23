import type {OutgoingHttpHeaders} from 'http'

export interface UsageCounts {
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
}

export interface ResponseLog {
    status?: number
    headers?: OutgoingHttpHeaders
    body?: string
    firstTokenAt?: number
    lastTokenAt?: number
    provider?: string
    model?: string
    usage?: UsageCounts
}

export const MAX_BODY = 1024 * 1024

/** Best-effort log side effect: recording must never break the proxied request
 *  or escape an event handler as an uncaught exception. */
export function safeLog (action: string, fn: () => void): void {
    try {
        fn()
    } catch (err) {
        console.error(`Failed to ${action}:`, err)
    }
}

export function logResponse (log: ResponseLog | undefined, update: ResponseLog): void {
    if (!log) return
    if (update.status !== undefined) log.status = update.status
    if (update.headers !== undefined) log.headers = update.headers
    if (update.body !== undefined) log.body = update.body
}

export function appendResponseBody (log: ResponseLog | undefined, chunk: string | Buffer): void {
    if (!log) return
    if ((log.body?.length ?? 0) >= MAX_BODY) return
    log.body = (log.body ?? '') + (typeof chunk === 'string' ? chunk : chunk.toString('utf-8'))
    if (log.body.length > MAX_BODY) log.body = log.body.slice(0, MAX_BODY)
}

const MAX_STREAM_CARRY = 1024 * 1024

export function applyUsageObject (usage: UsageCounts, obj: Record<string, unknown>): void {
    const usageObj = obj.usage
    if (usageObj && typeof usageObj === 'object') readUsageObject(usage, usageObj as Record<string, unknown>)
    const response = obj.response
    if (response && typeof response === 'object') applyUsageObject(usage, response as Record<string, unknown>)

    function readUsageObject (usage: UsageCounts, u: Record<string, unknown>): void {
        // Chat Completions (non-stream + stream usage frame)
        if (typeof u.prompt_tokens === 'number') usage.inputTokens = u.prompt_tokens
        if (typeof u.completion_tokens === 'number') usage.outputTokens = u.completion_tokens
        const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined
        if (promptDetails && typeof promptDetails.cached_tokens === 'number') usage.cachedTokens = promptDetails.cached_tokens

        // Responses API: usage is measured in input/output tokens, cached nested under input_tokens_details
        if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens
        if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens
        const inputDetails = u.input_tokens_details as Record<string, unknown> | undefined
        if (inputDetails && typeof inputDetails.cached_tokens === 'number') usage.cachedTokens = inputDetails.cached_tokens
    }
}

export function feedStreamUsage (state: {carry: string}, usage: UsageCounts, chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
    state.carry += text
    let newlineIdx: number
    while ((newlineIdx = state.carry.indexOf('\n')) !== -1) {
        const line = state.carry.slice(0, newlineIdx)
        state.carry = state.carry.slice(newlineIdx + 1)
        applyFrame(usage, line)
    }
    if (state.carry.length > MAX_STREAM_CARRY) {
        // Keep only the tail; usage frames arrive near the end of the stream.
        state.carry = state.carry.slice(-MAX_STREAM_CARRY)
    }

    function applyFrame (usage: UsageCounts, line: string): void {
        if (!line.startsWith('data:')) return
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') return
        try {
            applyUsageObject(usage, JSON.parse(payload) as Record<string, unknown>)
        } catch {
            // Ignore non-JSON SSE frames (comments, keep-alives, chunk boundaries).
        }
    }
}
