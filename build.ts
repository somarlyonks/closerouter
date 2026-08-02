#!/usr/bin/env node

import {readFileSync, writeFileSync, existsSync, statSync, readdirSync} from 'fs'
import {basename, join} from 'path'

// Convert .html files into .html.ts modules that export their content as a
// template string, so scriptc-compiled code can serve the HTML without a
// runtime file read - the source file does not exist inside the native binary.
//
// Run with Node (native TS, no compile step needed on Node 22.6+):
//   node build.ts                       # scan lib/server for *.html
//   node build.ts lib/server/logs/index.html
//   node build.ts lib/server/logs       # scan a directory
//
// For name.html the generated module exports `nameHTML`; kebab-case stems are
// camelCased (my-page.html -> myPageHTML). Backslashes and backticks in the
// source are escaped so the content survives the template literal unchanged.
// The HTML must not contain ${ (no template variables) - keep it out of the
// source, since it would be interpreted as interpolation.

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.scriptc', '.agents'])

function buildHtml (htmlPath: string): boolean {
    const out = htmlPath + '.ts'
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(htmlPath).mtimeMs) {
        return false // up to date
    }
    const src = readFileSync(htmlPath, 'utf8')
    const ts = `export const ${exportName(htmlPath)} = /* html */\`${escapeTemplate(src)}\`\n`
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
    const args = process.argv.slice(2)
    const targets = collectTargets(args.length ? args : ['lib/server'])

    if (!targets.length) {
        console.error('no .html files found')
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

    process.exit(0)
}

main()
