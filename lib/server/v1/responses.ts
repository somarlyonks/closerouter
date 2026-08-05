import {ServerResponse} from 'http'
import type {RequestContext} from '../../util'
import {proxyModelRequest} from '../../proxy'

export function handleResponses (
    ctx: RequestContext,
    res: ServerResponse,
): void {
    proxyModelRequest(ctx, res, '/responses')
}
