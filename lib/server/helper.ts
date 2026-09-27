/** In-flight upstream provider requests, tracked so shutdown can abort the
 *  stragglers: an endless generation must not hold server.close (and the
 *  process) open, nor keep burning provider resources after the drain period
 *  ends. A plain array backs the tracker because scriptc keys Map/Set only by
 *  number or string, never by object identity. */
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
    const requests: Array<() => void> = []
    return {
        track (abort: () => void): () => void {
            requests.push(abort)
            return () => {
                const idx = requests.indexOf(abort)
                if (idx >= 0) requests.splice(idx, 1)
            }
        },

        abortAll (): void {
            for (const abort of requests.splice(0, requests.length)) abort()
        },

        size (): number {
            return requests.length
        },
    }
}
