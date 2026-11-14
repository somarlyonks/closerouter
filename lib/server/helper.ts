import type {ServerResponse} from 'http'

/** In-flight requests the process owns but no client connection waits on:
 *  provider calls, and the usage rows posted to a remote db. Tracked so
 *  shutdown can drain them - a remote row must reach the owner before the
 *  process exits - and abort the stragglers past the drain period. A Set of
 *  abort callbacks backs the tracker: identity entries give O(1)
 *  delete-by-reference. */
export interface UpstreamTracker {
    /** Track one in-flight request; the returned callback settles it and must
     *  be called exactly once, whatever end it reaches. */
    track: (abort: () => void) => () => void
    /** Abort every still-tracked request and clear the registry. */
    abortAll: () => void
    /** Number of in-flight (tracked, unsettled) requests. */
    size: () => number
    /** Run `runWhenIdle` once nothing is tracked any more - immediately when
     *  the registry is already empty. */
    whenIdle: (runWhenIdle: () => void) => void
}

export function createUpstreamTracker (): UpstreamTracker {
    const aborts = new Set<() => void>()
    const idleHandlers: Array<() => void> = []

    function settle (abort: () => void): void {
        aborts.delete(abort)
        if (aborts.size === 0) notifyIdle()
    }

    function notifyIdle (): void {
        for (const handler of idleHandlers.splice(0)) handler()
    }

    return {
        track (abort: () => void): () => void {
            aborts.add(abort)
            return () => settle(abort)
        },

        abortAll (): void {
            // take the waiters out first: the aborts below settle synchronously
            // and must not fire the idle handlers from inside the loop
            const pending = [...aborts]
            const waiting = idleHandlers.splice(0)
            aborts.clear()
            for (const abort of pending) abort()
            for (const handler of waiting) handler()
        },

        size (): number {
            return aborts.size
        },

        whenIdle (runWhenIdle: () => void): void {
            if (aborts.size === 0) runWhenIdle()
            else idleHandlers.push(runWhenIdle)
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

export interface HttpTarget {
    isHttps: boolean
    hostname: string
    port: number
    path: string
    /** scheme://host[:port], for messages that name the service they failed to reach. */
    origin: string
}

export function resolveTarget (baseUrl: string, path: string): HttpTarget {
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    const targetUrl = new URL(normalizedBaseUrl + path)
    const isHttps = targetUrl.protocol === 'https:'

    return {
        isHttps,
        hostname: getHostname(targetUrl),
        port: getPort(targetUrl, isHttps),
        path: targetUrl.pathname + targetUrl.search,
        origin: targetUrl.origin,
    }

    function getPort (targetUrl: URL, isHttps: boolean): number {
        if (targetUrl.port !== '') return Number(targetUrl.port)
        return isHttps ? 443 : 80
    }

    // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), but
    // http.request's hostname option wants the bare address.
    function getHostname (targetUrl: URL): string {
        const hostname = targetUrl.hostname
        if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1)
        return hostname
    }
}
