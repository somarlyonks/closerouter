import {IncomingMessage, ServerResponse} from 'http'
import {Router} from '../router'

export function handleListModels (
    _clientReq: IncomingMessage,
    clientRes: ServerResponse,
    router: Router,
): void {
    const response = {
        object: 'list',
        data: router.listModels(),
    }

    clientRes.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
    })
    clientRes.end(JSON.stringify(response, undefined, 2))
}
