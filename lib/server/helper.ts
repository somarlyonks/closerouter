import type {ServerResponse} from 'http'

/** In-flight upstream provider requests, tracked so shutdown can abort the
 *  stragglers: an endless generation must not hold server.close (and the
 *  process) open, nor keep burning provider resources after the drain period
 *  ends. A Set of identity entries backs the tracker - scriptc Set elements
 *  may be records but not bare functions, and delete-by-reference is O(1). */
export interface UpstreamTracker {
    /** Track one in-flight upstream request; the returned callback settles it
     *  and must be called exactly once, whatever end it reaches. */
    track: (abort: () => void) => () => void
    /** Abort every still-tracked request and clear the registry. */
    abortAll: () => void
    /** Number of in-flight (tracked, unsettled) requests. */
    size: () => number
}

export function createUpstreamTracker (): UpstreamTracker {
    const requests = new Set<{abort: () => void}>()
    return {
        track (abort: () => void): () => void {
            const entry = {abort}
            requests.add(entry)
            return () => {
                requests.delete(entry)
            }
        },

        abortAll (): void {
            for (const entry of requests) entry.abort()
            requests.clear()
        },

        size (): number {
            return requests.size
        },
    }
}

/** Cached aggregated model list, held per running server (not process-global)
 *  so /v1/models can serve instantly and refresh in the background. */
export interface ModelsCache {
    /** The last fetched model list, or undefined before the first fetch. */
    get: () => unknown[] | undefined
    /** True when nothing has been fetched yet or the cached list is past its TTL. */
    isStale: () => boolean
    /** Re-fetch through `fetcher`, coalescing concurrent refreshes into one call. */
    refresh: (fetcher: () => Promise<unknown[]>) => Promise<unknown[]>
    /** Drop the cached list and forget any in-flight refresh, so the next
     *  request re-fetches (used when the config is hot-replaced). */
    invalidate: () => void
}

/** How long a cached model list stays fresh; past this it is served
 *  stale-while-revalidate (the caller serves it and refreshes in the background). */
export const MODEL_LIST_CACHE_TTL_MS = 600_000

export function createModelsCache (ttlMs: number = MODEL_LIST_CACHE_TTL_MS): ModelsCache {
    let cached: unknown[] | undefined
    let updatedAt = 0
    let inFlight: {generation: number, promise: Promise<unknown[]>} | undefined
    let generation = 0

    return {
        get () {
            return cached
        },
        isStale () {
            return cached === undefined || Date.now() - updatedAt >= ttlMs
        },
        refresh (fetcher) {
            if (inFlight === undefined) {
                const started = generation
                const promise = fetcher().then((models) => {
                    if (started === generation) {
                        cached = models
                        updatedAt = Date.now()
                    }
                    return models
                }).finally(() => {
                    if (inFlight !== undefined && inFlight.generation === started) inFlight = undefined
                })
                inFlight = {generation: started, promise}
            }
            return inFlight.promise
        },
        invalidate () {
            generation += 1
            cached = undefined
            updatedAt = 0
            inFlight = undefined
        },
    }
}

/** Baseline CORS headers for every response, applied once before dispatch so
 *  no route handler repeats them and error responses (401/404/405/500) stay
 *  readable from a browser. The proxy strips the provider's own CORS headers,
 *  so these are the single source of CORS truth in either direction. */
export function applyCors (res: ServerResponse): void {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-expose-headers', '*')
}
