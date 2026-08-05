import {ServerResponse} from 'http'
import type {RequestContext} from '../../../util'
import {proxyModelRequest} from '../../../proxy'

export function handleChatCompletions (
    ctx: RequestContext,
    res: ServerResponse,
): void {
    proxyModelRequest(ctx, res, '/chat/completions')
}
