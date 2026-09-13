#!/usr/bin/env node

import {readFileSync, writeFileSync, existsSync, statSync, readdirSync} from 'fs'
import {basename, dirname, join} from 'path'

// Convert .html/.json sources under lib/ into .ts modules so scriptc can
// embed/serve them with no runtime file read. Each module exports a fixed
// name - `html` (template string) or `json` (verbatim object literal) - which
// importers alias locally, e.g.:
//   import {html as indexHTML} from './index.html'
//   import {json as schema} from './schema.json.ts'
//
// Usage: node assets/build.ts [file-or-dir ...] (default: lib/server lib/config)
//
// Gotchas: contents must not contain ${ (it becomes a template literal); import
// .json.ts with the explicit extension, since scriptc resolves './x.json' to
// the raw JSON module. An assets/ dir in any ancestor is scanned for
// /* @asset <name> */ markers in HTML, replaced with the file's contents.

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.scriptc', '.agents'])
const ASSET_MARKER = /\/\*\s*@asset\s+([\w./-]+)\s*\*\//g

function findAssetsDir (htmlPath: string): string | undefined {
    let dir = dirname(htmlPath)
    while (true) {
        const candidate = join(dir, 'assets')
        if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
    }
    return undefined
}

function buildHtml (htmlPath: string): void {
    const out = htmlPath + '.ts'
    const assetsDir = findAssetsDir(htmlPath)
    const src = readFileSync(htmlPath, 'utf8')

    const unresolved: string[] = []
    let processed = src
    if (assetsDir) {
        processed = src.replace(ASSET_MARKER, (match, name) => {
            const assetPath = join(assetsDir, name)
            if (existsSync(assetPath) && statSync(assetPath).isFile()) {
                return readFileSync(assetPath, 'utf8').trim()
            }
            unresolved.push(match.trim())
            return match
        })
    } else {
        for (const match of src.match(ASSET_MARKER) ?? []) unresolved.push(match.trim())
    }

    if (unresolved.length > 0) {
        console.error(`unresolved @asset marker(s) in ${htmlPath}: ${unresolved.join(' ')}`)
        process.exit(1)
    }

    writeFileSync(out, `export const html = /* ${basename(htmlPath)} */\`${escapeTemplate(processed)}\`\n`)

    function escapeTemplate (src: string): string {
        return src
            .split('\\').join('\\\\')
            .split('`').join('\\`')
            .split('$').join('\\$')
    }
}

function buildJson (jsonPath: string): void {
    const out = jsonPath + '.ts'
    // The JSON document is itself a valid TS expression, embed it verbatim.
    writeFileSync(out, `export const json = /* ${basename(jsonPath)} */ ${readFileSync(jsonPath, 'utf8').trimEnd()}\n`)
}

function collectTargets (args: string[]): string[] {
    const files: string[] = []
    for (const arg of args) {
        if (!existsSync(arg)) {
            console.error('not found: ' + arg)
            continue
        }
        const st = statSync(arg)
        if (st.isDirectory()) {
            files.push(...findSourceFiles(arg))
        } else if (arg.endsWith('.html')) {
            files.push(arg)
        } else if (arg.endsWith('.json')) {
            files.push(arg)
        } else {
            console.error('skip (not .html/.json): ' + arg)
        }
    }
    return files

    function findSourceFiles (root: string): string[] {
        const out: string[] = []
        function walk (dir: string): void {
            for (const entry of readdirSync(dir, {withFileTypes: true})) {
                if (entry.isDirectory()) {
                    if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
                } else if (entry.isFile() && (entry.name.endsWith('.html') || entry.name.endsWith('.json'))) {
                    out.push(join(dir, entry.name))
                }
            }
        }
        walk(root)
        return out
    }
}

function main (): void {
    console.group('> assets/build.ts')
    const args = process.argv.slice(2)
    const targets = collectTargets(args.length ? args : ['lib/server', 'lib/config'])

    if (!targets.length) {
        console.error('no .html/.json files found')
        console.groupEnd()
        process.exit(1)
    }

    for (const f of targets) {
        if (f.endsWith('.json')) buildJson(f)
        else buildHtml(f)
        console.log(`${f} -> ${f}.ts`)
    }
    console.log(`done: ${targets.length} regenerated`)
    console.groupEnd()

    process.exit(0)
}

main()
