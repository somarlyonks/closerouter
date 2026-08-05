import {router, needsAuth} from '../../util'
import {handleChatCompletions} from './chat/completions'
import {handleResponses} from './responses'
import {handleListModels} from './models'

export const v1Router = needsAuth(router(
    ({req}) => req.method === 'GET' && req.url === '/v1/models',
    handleListModels,
    router(
        ({req}) => req.method === 'POST' && req.url === '/v1/chat/completions',
        handleChatCompletions,
        router(
            ({req}) => req.method === 'POST' && req.url === '/v1/responses',
            handleResponses,
        ),
    ),
))
