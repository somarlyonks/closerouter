import {needsAuth, withMethod} from '../util'
import {getUsageTotals} from './logs/db'

export const handleUsage = withMethod('GET')(needsAuth((_ctx, res) => {
    const totals = getUsageTotals()
    res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
    })
    res.end(JSON.stringify(totals ?? {count: 0, inTokens: 0, outTokens: 0}))
}))
