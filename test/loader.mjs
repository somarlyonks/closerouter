import {registerHooks} from 'node:module'
import {existsSync} from 'fs'
import {fileURLToPath, pathToFileURL} from 'url'
import {dirname, join, extname} from 'path'

// Synchronous ESM resolve hook that lets TypeScript source be imported with
// extensionless relative specifiers (the style used throughout `lib/`), so the
// test suite can run the project's `.ts` sources directly under `node --test`
// with native type stripping and no extra dependencies.

const EXT = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.json'])

function find (base) {
    for (const e of EXT) {
        if (existsSync(base + e)) return base + e
    }
    if (existsSync(base) && JS_EXT.has(extname(base))) return base
    for (const e of EXT) {
        if (existsSync(join(base, 'index' + e))) return join(base, 'index' + e)
    }
    return undefined
}

registerHooks({
    resolve (specifier, context, nextResolve) {
        if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../'))) {
            const base = join(dirname(fileURLToPath(context.parentURL)), specifier)
            const found = find(base)
            if (found) return nextResolve(pathToFileURL(found).href, context)
        }
        return nextResolve(specifier, context)
    },
})
