import {needsAuth, withMethod} from '../util'
import {loadUsageHeatmap, loadUsageStats} from './logs/db'

export const handleUsage = withMethod('GET')(needsAuth((ctx, res) => {
    const url = new URL('http://localhost' + (ctx.req.url ?? '/'))
    const num = (name: string): number | undefined => {
        const v = url.searchParams.get(name)
        return v !== null && /^\d+$/.test(v) ? Number(v) : undefined
    }
    const filters = {
        from: num('from'),
        to: num('to'),
        provider: url.searchParams.get('provider') ?? undefined,
        model: url.searchParams.get('model') ?? undefined,
    }
    const stats = loadUsageStats(filters)
    const heatmap = url.searchParams.get('heatmap') === '1' ? loadUsageHeatmap(filters) : undefined
    res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
    })
    res.end(JSON.stringify({...stats, heatmap}))
}))
