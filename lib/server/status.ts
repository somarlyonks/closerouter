import {withMethod} from '../util'

export const handleStatus = withMethod('GET')((_ctx, res) => {
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({status: 'ok'}))
})
