#!/usr/bin/env node

// Compile the C sources behind ffi.json's libraries[] entries, each in place
// (the .o lands next to its .c), for `scriptc build --ffi` - the manifest
// requires every listed object to exist at build time. An entry with a sibling
// .c is compiled here when stale; an entry without one must already exist (a
// prebuilt object supplied by hand). Runs under plain Node (it is a build
// tool like assets/build.ts, not shipped code).

import {spawnSync} from 'child_process'
import {existsSync, readFileSync, statSync} from 'fs'
import {dirname, join, relative, resolve} from 'path'
import {fileURLToPath} from 'url'

const DIR = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(DIR, 'ffi.json')

function rel (path: string): string {
    return relative(process.cwd(), path)
}

function sdkPath (): string | undefined {
    if (process.platform !== 'darwin') return undefined
    const res = spawnSync('xcrun', ['--show-sdk-path'], {encoding: 'utf8'})
    return res.status === 0 ? res.stdout.trim() : undefined
}

function compile (src: string, out: string): void {
    const args = ['-O2', '-Wall']
    const sdk = sdkPath()
    if (sdk) args.push('-isysroot', sdk)
    args.push('-c', src, '-o', out)

    const res = spawnSync('clang', args, {stdio: ['ignore', 'inherit', 'inherit']})
    if (res.error) {
        console.error('clang not found - install Xcode Command Line Tools (xcode-select --install)')
        process.exit(1)
    }
    if (res.status !== 0) process.exit(1)
    console.log(`${rel(src)} -> ${rel(out)}`)
}

function main (): void {
    console.group('> native/build.ts')
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {libraries?: string[]}
    const entries = manifest.libraries ?? []
    if (!entries.length) {
        console.error(`${rel(MANIFEST)}: no libraries listed`)
        console.groupEnd()
        process.exit(1)
    }

    let compiled = 0
    let upToDate = 0

    for (const entry of entries) {
        // scriptc resolves library paths relative to the manifest
        const out = resolve(DIR, entry)
        const src = out.replace(/\.o$/, '.c')

        if (out.endsWith('.o') && existsSync(src)) {
            if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
                upToDate++
                continue
            }
            compile(src, out)
            compiled++
            continue
        }

        if (!existsSync(out)) {
            console.error(`missing: ${rel(out)} (no sibling .c to compile and no prebuilt object)`)
            process.exit(1)
        }
        console.log(`${rel(out)} prebuilt`)
    }

    console.log(`done: ${compiled} compiled, ${upToDate} up to date`)
    console.groupEnd()
}

main()
