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

test('upstream tracker reports idle once the last tracked request settles', () => {
    const upstream = createUpstreamTracker()
    const idle: number[] = []

    upstream.whenIdle(() => idle.push(upstream.size()))
    assert.deepEqual(idle, [0], 'an empty tracker is idle at once')

    const settleA = upstream.track(() => {})
    const settleB = upstream.track(() => {})
    upstream.whenIdle(() => idle.push(upstream.size()))
    assert.deepEqual(idle, [0], 'a registered waiter does not fire while requests are tracked')

    settleA()
    assert.equal(idle.length, 1, 'one straggler left: still not idle')
    settleB()
    assert.deepEqual(idle, [0, 0], 'the waiter fires once the tracker empties')

    settleB()
    assert.equal(idle.length, 2, 'a repeated settle is inert')
})

test('upstream tracker abortAll settles the idle waiters too', () => {
    const upstream = createUpstreamTracker()
    const idle: string[] = []
    let aborted = 0

    upstream.track(() => {
        aborted++
    })
    upstream.whenIdle(() => idle.push('idle'))
    upstream.abortAll()

    assert.equal(aborted, 1)
    assert.deepEqual(idle, ['idle'], 'an aborted request counts as settled for the drain wait')
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
