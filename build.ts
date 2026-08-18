#!/usr/bin/env node

import {spawnSync} from 'child_process'

function run (script: string, args: string[] = []): void {
    const res = spawnSync(process.execPath, [script, ...args], {stdio: 'inherit'})
    if (res.error) {
        console.error(`failed to run ${script}: ${res.error.message}`)
        process.exit(1)
    }
    if (res.status !== 0) process.exit(res.status ?? 1)
}

const scripts = [
    'assets/build.ts',
    'native/build.ts',
]

function main () {
    for (const script of scripts) run(script)
}

main()
