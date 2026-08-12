import {withMethod} from '../util'
import packageJson from '../../package.json' with {type: 'json'}

export const handleStatus = withMethod('GET')((_ctx, res) => {
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({
        version: packageJson.version,
        status: 'ok',
    }))
})
