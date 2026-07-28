import {IncomingMessage, ServerResponse} from 'http'
import {Router} from '../router.js'

export function handleListModels (
    _clientReq: IncomingMessage,
    clientRes: ServerResponse,
    router: Router,
): void {
    const models = router.listModels()

    const response = {
        object: 'list',
        data: models.map(id => ({
            id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'closerouter',
        })),
    }

    clientRes.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
    })
    clientRes.end(JSON.stringify(response, undefined, 2))
}
