#!/usr/bin/env node

import {readFileSync, writeFileSync, existsSync, statSync, readdirSync} from 'fs'
import {basename, dirname, join} from 'path'

// Convert .html files into .html.ts modules that export their content as a
// template string, so scriptc-compiled code can serve the HTML without a
// runtime file read - the source file does not exist inside the native binary.
//
// Run with Node (native TS, no compile step needed on Node 22.6+), from the
// package root (the root build.ts orchestrator also invokes it):
//   node assets/build.ts                       # scan lib/server for *.html
//   node assets/build.ts lib/server/logs/index.html
//   node assets/build.ts lib/server/logs       # scan a directory
//
// For name.html the generated module exports `nameHTML`; kebab-case stems are
// camelCased (my-page.html -> myPageHTML). Backslashes and backticks in the
// source are escaped so the content survives the template literal unchanged.
// The HTML must not contain ${ (no template variables) - keep it out of the
// source, since it would be interpreted as interpolation.
//
// An assets/ directory can be placed in any ancestor of an HTML file. Each
// file inside it can be inlined into the HTML via a marker comment of the form
// /* @asset <name> */ (e.g. /* @asset index.css */), so shared styles, scripts,
// or fragments live in one place without runtime requests. The marker is
// replaced with the file contents during this build step.

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

function buildHtml (htmlPath: string): boolean {
    const out = htmlPath + '.ts'
    const assetsDir = findAssetsDir(htmlPath)
    const src = readFileSync(htmlPath, 'utf8')

    const assetPaths: string[] = []
    let processed = src
    if (assetsDir) {
        processed = src.replace(ASSET_MARKER, (match, name) => {
            const assetPath = join(assetsDir, name)
            if (existsSync(assetPath) && statSync(assetPath).isFile()) {
                assetPaths.push(assetPath)
                return readFileSync(assetPath, 'utf8').trim()
            }
            console.error(`asset not found: ${name} (referenced in ${htmlPath})`)
            return match
        })
    }

    const outMtime = existsSync(out) ? statSync(out).mtimeMs : 0
    if (outMtime >= statSync(htmlPath).mtimeMs
        && assetPaths.every(p => outMtime >= statSync(p).mtimeMs)) {
        return false // up to date
    }

    const ts = `export const ${exportName(htmlPath)} = /* html */\`${escapeTemplate(processed)}\`\n`
    writeFileSync(out, ts)
    return true

    function exportName (htmlPath: string): string {
        const stem = basename(htmlPath, '.html')
        return stem.split('-').map((part, i) =>
            i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
        ).join('') + 'HTML'
    }

    function escapeTemplate (src: string): string {
        return src
            .split('\\').join('\\\\')
            .split('`').join('\\`')
            .split('$').join('\\$')
    }
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
            files.push(...findHtmlFiles(arg))
        } else if (arg.endsWith('.html')) {
            files.push(arg)
        } else {
            console.error('skip (not .html): ' + arg)
        }
    }
    return files

    function findHtmlFiles (root: string): string[] {
        const out: string[] = []
        function walk (dir: string): void {
            for (const entry of readdirSync(dir, {withFileTypes: true})) {
                if (entry.isDirectory()) {
                    if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name))
                } else if (entry.isFile() && entry.name.endsWith('.html')) {
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
    const targets = collectTargets(args.length ? args : ['lib/server'])

    if (!targets.length) {
        console.error('no .html files found')
        console.groupEnd()
        process.exit(1)
    }

    let written = 0
    for (const f of targets) {
        if (buildHtml(f)) {
            console.log(`${f} -> ${f}.ts`)
            written++
        }
    }
    console.log(`done: ${written} written, ${targets.length - written} up to date`)
    console.groupEnd()

    process.exit(0)
}

main()
