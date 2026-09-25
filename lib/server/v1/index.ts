import {router, needsAuth, withMethod, path, asyncHandler} from '../../router'
import {handleListModels} from './models'
import {proxyModelRequest} from '../../proxy'

export const v1Router = needsAuth(router(
    path('/v1/models'),
    withMethod('GET')(asyncHandler(handleListModels)),
    withMethod('POST')((ctx, res) => proxyModelRequest(ctx, res, ctx.req.url!.replace(/^\/v1/, ''))),
))
