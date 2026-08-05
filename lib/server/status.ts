import {router} from '../util'

export const handleStatus = router(
    c => c.req.method === 'GET',
    (_ctx, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({status: 'ok'}))
    },
    (_ctx, res) => {
        res.writeHead(405, {
            'content-type': 'application/json',
            'allow': 'GET',
        })
        res.end(JSON.stringify({
            error: {
                message: 'Method Not Allowed',
                type: 'method_not_allowed',
            },
        }))
    },
)
