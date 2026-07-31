import {IncomingMessage, ServerResponse} from 'http'

export function handleListModels (
    _clientReq: IncomingMessage,
    clientRes: ServerResponse,
): void {
    const response = {
        object: 'list',
        data: [],
    }

    clientRes.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
    })
    clientRes.end(JSON.stringify(response, undefined, 2))
}
