import {router, needsAuth, withMethod, path} from '../../router'
import {handleListModels} from './models'
import {proxyModelRequest} from '../../proxy'

export const v1Router = needsAuth(router(
    path('/v1/models'),
    withMethod('GET')((ctx, res) => {handleListModels(ctx, res)}),
    withMethod('POST')((ctx, res) => proxyModelRequest(ctx, res, ctx.req.url!.replace(/^\/v1/, ''))),
))
