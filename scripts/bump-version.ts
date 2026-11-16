#!/usr/bin/env node

// Bump the version, commit it, tag it and push. bump.yml runs this on every
// push to master and then starts release.yml for the new tag; nothing here
// builds or publishes.
//
//   node scripts/bump-version.ts            # bump derived from commits since the last release
//   node scripts/bump-version.ts minor      # forced bump (patch|minor|major)
//
// Exit codes: 0 released, 3 nothing to release, 1 error. With GITHUB_OUTPUT
// set (GitHub Actions), `tag` receives the new tag or an empty string.
//
// package.json is the only place the version lives: the binary embeds it and
// `npm run prebuild:app` feeds it to xcodegen as the app's MARKETING_VERSION.

import {execFileSync} from 'child_process'
import {appendFileSync, readFileSync, writeFileSync} from 'fs'
import {dirname, join} from 'path'
import {fileURLToPath} from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

type Bump = 'major' | 'minor' | 'patch'

const BUMPS: Bump[] = ['major', 'minor', 'patch']
const NOTHING_TO_RELEASE = 3
const BOT_COMMIT_IDENTITY = [
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
]
const VERSION_FILES = ['package.json', 'package-lock.json', 'closerouter.json']
const RELEASE_COMMIT_TYPES = new Set(['feat', 'fix', 'perf', 'revert'])
const CONVENTIONAL_SUMMARY = /^(\w+)(?:\([^)]*\))?(!)?:/
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m

interface PackageLock {
    version?: string
    packages?: Record<string, {version?: string}>
}

interface SampleConfig {
    $schema?: string
}

function git (...args: string[]): string {
    return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trimEnd()
}

function gitOrUndefined (...args: string[]): string | undefined {
    try {
        return git(...args)
    } catch {
        return undefined
    }
}

function readJson<Value> (name: string): Value {
    return JSON.parse(readFileSync(join(ROOT, name), 'utf8')) as Value
}

function writeJson (name: string, value: unknown): void {
    writeFileSync(join(ROOT, name), `${JSON.stringify(value, null, 4)}\n`)
}

function writeGithubOutput (tag: string): void {
    const output = process.env.GITHUB_OUTPUT
    if (output) appendFileSync(output, `tag=${tag}\n`)
}

function requestedBump (argv: string[]): Bump | undefined {
    const [requested] = argv
    if (!requested || requested === 'auto') return undefined
    if (!BUMPS.includes(requested as Bump)) {
        throw new Error(`unsupported bump: ${requested} (expected ${BUMPS.join('|')})`)
    }
    return requested as Bump
}

function localCommit (ref: string): string | undefined {
    return gitOrUndefined('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
}

function isAncestor (ref: string): boolean {
    try {
        git('merge-base', '--is-ancestor', ref, 'HEAD')
        return true
    } catch {
        return false
    }
}

function remoteCommit (tag: string): string | undefined {
    const listing = gitOrUndefined('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)
    if (!listing) return undefined

    const lines = listing.split('\n')
    const peeled = lines.find(line => line.endsWith(`refs/tags/${tag}^{}`))
    const line = peeled ?? lines.find(candidate => candidate.endsWith(`refs/tags/${tag}`))
    return line?.split('\t')[0]
}

function lastTag (): string | undefined {
    return gitOrUndefined('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*')
}

/** The tag the current package.json version was released as, when this history
 *  actually contains it - a local tag left behind by a rewritten branch would
 *  otherwise make the commit range count already shipped work. */
function releaseBase (current: string): string | undefined {
    const versionTag = `v${current}`
    const local = localCommit(versionTag)

    if (local && isAncestor(versionTag)) return versionTag

    if (local) {
        const remote = remoteCommit(versionTag)
        if (remote && remote !== local) {
            throw new Error(`local ${versionTag} tags ${local.slice(0, 7)}, origin has ${remote.slice(0, 7)} - the local tag is stale`)
        }
        console.warn(`warning: ${versionTag} tags ${local.slice(0, 7)}, which this history does not contain`)
    }

    const base = lastTag()
    console.warn(`warning: counting since ${base ?? 'the first commit'} instead, which may over-count already released changes`)
    return base
}

/** How one commit message bumps the version, or undefined when it is not a
 *  user-facing change. */
function bumpForCommit (message: string): Bump | undefined {
    const [summary = ''] = message.trim().split('\n')
    const match = CONVENTIONAL_SUMMARY.exec(summary)
    if (!match) return undefined
    if (match[2] === '!' || BREAKING_FOOTER.test(message)) return 'major'
    if (match[1] === 'feat') return 'minor'
    return RELEASE_COMMIT_TYPES.has(match[1]) ? 'patch' : undefined
}

function inferBump (current: string): Bump | undefined {
    const tag = releaseBase(current)
    const range = tag ? `${tag}..HEAD` : 'HEAD'
    const log = gitOrUndefined('log', '--format=%B%x1e', range) ?? ''
    const bumps = log
        .split('\x1e')
        .map(bumpForCommit)
        .filter((bump): bump is Bump => bump !== undefined)

    return BUMPS.find(candidate => bumps.includes(candidate))
}

function nextVersion (current: string, bump: Bump): string {
    const parts = current.split('.').map(part => Number.parseInt(part, 10))
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
        throw new Error(`unsupported version in package.json: ${current}`)
    }

    const [major, minor, patch] = parts
    if (bump === 'major') return `${major + 1}.0.0`
    if (bump === 'minor') return `${major}.${minor + 1}.0`
    return `${major}.${minor}.${patch + 1}`
}

/** Point the sample config's $schema at the new tag so editors keep resolving
 *  the schema that shipped with that release. */
function writeVersion (next: string): void {
    const manifest = readJson<{version: string}>('package.json')
    writeJson('package.json', {...manifest, version: next})

    const lock = readJson<PackageLock>('package-lock.json')
    lock.version = next
    if (lock.packages?.['']) lock.packages[''].version = next
    writeJson('package-lock.json', lock)

    const sample = readJson<SampleConfig>('closerouter.json')
    if (typeof sample.$schema === 'string') {
        sample.$schema = sample.$schema.replace(/\/refs\/tags\/v[0-9][^/]*/, `/refs/tags/v${next}`)
    }
    writeJson('closerouter.json', sample)
}

function commitTagAndPush (tag: string): void {
    const identity = gitOrUndefined('config', 'user.email') ? [] : BOT_COMMIT_IDENTITY
    git('add', ...VERSION_FILES)
    git(...identity, 'commit', '-m', `chore(release): ${tag}`)

    // The commit goes out before the tag exists, so a rejected push cannot
    // leave a local tag behind that a retry would then trip over.
    git('push', 'origin', 'HEAD')
    git('tag', tag)
    git('push', 'origin', tag)
    writeGithubOutput(tag)
    console.log(`pushed ${tag}`)
}

function main (): void {
    // Pushing a release commit with a token (not GITHUB_TOKEN) triggers this
    // workflow again, so the commit it produced must not bump twice.
    const head = gitOrUndefined('log', '-1', '--format=%s') ?? ''
    if (/^chore\(release\):/.test(head)) {
        console.log(`nothing to release: HEAD is already ${head}`)
        writeGithubOutput('')
        process.exit(NOTHING_TO_RELEASE)
    }

    const current = readJson<{version: string}>('package.json').version
    const bump = requestedBump(process.argv.slice(2)) ?? inferBump(current)

    if (!bump) {
        console.log(`nothing to release: no releasable commit since ${lastTag() ?? 'the first commit'}`)
        writeGithubOutput('')
        process.exit(NOTHING_TO_RELEASE)
    }

    const next = nextVersion(current, bump)
    const tag = `v${next}`
    if (localCommit(tag)) throw new Error(`tag ${tag} already exists`)

    console.log(`bumping ${current} -> ${next} (${bump})`)
    writeVersion(next)
    commitTagAndPush(tag)
}

try {
    main()
} catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
}
