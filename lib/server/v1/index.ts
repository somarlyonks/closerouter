import {router, needsAuth, withMethod} from '../../util'
import { handleListModels } from './models'
import {proxyModelRequest} from '../../proxy'


export const v1Router = needsAuth(router(
    ({req}) => req.url === '/v1/models',
    withMethod('GET')(handleListModels),
    withMethod('POST')((ctx, res) => {
        proxyModelRequest(ctx, res, ctx.req.url!.replace(/^\/v1/, ''))
    }),
))
