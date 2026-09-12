import {withMethod} from '../util'
import {getSqliteVersion} from '../db'
import packageJson from '../../package.json' with {type: 'json'}

export const handleStatus = withMethod('GET')((ctx, res) => {
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify({
        version: packageJson.version,
        status: 'ok',
        sqlite: sqliteVersion(),
    }))

    function sqliteVersion (): string | undefined {
        if (ctx.env.config.dbPath === undefined) return undefined
        try {
            return getSqliteVersion()
        } catch {
            return undefined
        }
    }
})
