import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createUpstreamTracker} from '../lib/server/helper'

test('upstream tracker counts tracked requests until they settle', () => {
    const upstream = createUpstreamTracker()
    assert.equal(upstream.size(), 0)

    const settleA = upstream.track(() => {})
    const settleB = upstream.track(() => {})
    assert.equal(upstream.size(), 2)

    settleA()
    assert.equal(upstream.size(), 1)

    // settling twice must not double-remove or throw
    settleA()
    assert.equal(upstream.size(), 1)

    settleB()
    assert.equal(upstream.size(), 0)
})

test('upstream tracker abortAll aborts every unsettled request exactly once', () => {
    const upstream = createUpstreamTracker()
    let abortedA = 0
    let abortedB = 0
    let settledAborted = 0

    const abortA = (): void => {
        abortedA++
    }
    const abortB = (): void => {
        abortedB++
    }
    upstream.track(abortA)
    const settleB = upstream.track(abortB)
    settleB()

    upstream.abortAll()
    assert.equal(abortedA, 1)
    assert.equal(abortedB, 0) // already settled - not aborted

    // a second abort pass has nothing left to abort
    upstream.abortAll()
    assert.equal(abortedA, 1)
    assert.equal(upstream.size(), 0)

    // requests tracked after abortAll are still registered normally
    const abortLate = (): void => {
        settledAborted++
    }
    const settleLate = upstream.track(abortLate)
    assert.equal(upstream.size(), 1)
    settleLate()
    assert.equal(upstream.size(), 0)
    assert.equal(settledAborted, 0)
})
