import {router, needsAuth, withMethod, path, asyncHandler} from '../../router'
import {listModelsHandler} from './models'
import {proxyModelRequest} from '../../proxy'

export const v1Router = needsAuth(router(
    path('/v1/models'),
    withMethod('GET')(asyncHandler(listModelsHandler())),
    withMethod('POST')((ctx, res) => proxyModelRequest(ctx, res, ctx.req.url!.replace(/^\/v1/, ''))),
))
