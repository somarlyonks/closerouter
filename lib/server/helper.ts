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

/** Baseline CORS headers for every response, applied once before dispatch so
 *  no route handler repeats them and error responses (401/404/405/500) stay
 *  readable from a browser. The proxy strips the provider's own CORS headers,
 *  so these are the single source of CORS truth in either direction. */
export function applyCors (res: ServerResponse): void {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-expose-headers', '*')
}
