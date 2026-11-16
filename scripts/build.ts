#!/usr/bin/env node

// Build preparation: run every step that turns sources into modules scriptc can
// compile statically. Steps keep their own directory - assets/build.ts inlines
// HTML/JSON, native/build.ts compiles the FFI shims listed in native/ffi.json.
// Runs under plain Node.

import {spawnSync} from 'child_process'
import {dirname, join} from 'path'
import {fileURLToPath} from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const STEPS = [
    'assets/build.ts',
    'native/build.ts',
]

function run (step: string): void {
    const res = spawnSync(process.execPath, [join(ROOT, step)], {cwd: ROOT, stdio: 'inherit'})
    if (res.error) {
        console.error(`failed to run ${step}: ${res.error.message}`)
        process.exit(1)
    }
    if (res.status !== 0) process.exit(res.status ?? 1)
}

function main () {
    for (const step of STEPS) run(step)
}

main()
