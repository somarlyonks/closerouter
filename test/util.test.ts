import {test} from 'node:test'
import assert from 'node:assert/strict'
import {normalizeModel, router, needsAuth} from '../lib/util'
import type {RequestContext} from '../lib/util'
import {mockReq, mockRes, sampleConfig} from './helpers'

function ctx (opts: {method?: string, url?: string, headers?: Record<string, string>} = {}): RequestContext {
    return {
        req: mockReq(opts),
        env: {config: sampleConfig({key: 'secret'})},
    }
}

test('normalizeModel wraps a string model as {id: "provider/model"}', () => {
    assert.deepEqual(normalizeModel('p', 'gpt'), {id: 'p/gpt'})
})

test('normalizeModel prefixes an object model id and defaults owned_by', () => {
    assert.deepEqual(normalizeModel('p', {id: 'm'}), {id: 'p/m', owned_by: 'p'})
})

test('normalizeModel preserves an explicit owned_by', () => {
    assert.deepEqual(normalizeModel('p', {id: 'm', owned_by: 'vendor'}), {id: 'p/m', owned_by: 'vendor'})
})

test('normalizeModel throws when model object has no id', () => {
    assert.throws(() => normalizeModel('p', {}), /Model config broken/)
    assert.throws(() => normalizeModel('p', undefined), /Model config broken/)
    assert.throws(() => normalizeModel('p', 5), /Model config broken/)
})

test('router runs handler when predicate is true', () => {
    const h = router(
        () => true,
        (_c, r) => {
            r.writeHead(200)
            r.end('hit')
        },
        (_c, r) => {
            r.writeHead(404)
            r.end('nope')
        },
    )
    const res = mockRes()
    h(ctx(), res)
    assert.equal(res.captured.statusCode, 200)
    assert.equal(res.captured.body, 'hit')
})

test('router falls through to cont when predicate is false', () => {
    const h = router(
        () => false,
        (_c, r) => {
            r.writeHead(200)
            r.end('hit')
        },
        (_c, r) => {
            r.writeHead(404)
            r.end('nope')
        },
    )
    const res = mockRes()
    h(ctx(), res)
    assert.equal(res.captured.statusCode, 404)
    assert.equal(res.captured.body, 'nope')
})

test('router defaults to a 404 handler when cont is omitted', () => {
    const h = router(() => false, (_c, r) => {
        r.writeHead(200)
        r.end('hit')
    })
    const res = mockRes()
    h(ctx({method: 'POST', url: '/missing'}), res)
    assert.equal(res.captured.statusCode, 404)
    assert.match(res.captured.body, /Not found: POST \/missing/)
})

test('needsAuth rejects requests without authorization', () => {
    const handler = needsAuth((_c, r) => {
        r.writeHead(200)
        r.end('ok')
    })
    const res = mockRes()
    handler(ctx({headers: {}}), res)
    assert.equal(res.captured.statusCode, 401)
    assert.equal(res.captured.headers['content-type'], 'application/json')
    assert.match(res.captured.body, /authentication_error/)
})

test('needsAuth rejects requests with a wrong key', () => {
    const handler = needsAuth((_c, r) => {
        r.writeHead(200)
        r.end('ok')
    })
    const res = mockRes()
    handler(ctx({headers: {authorization: 'Bearer wrong'}}), res)
    assert.equal(res.captured.statusCode, 401)
})

test('needsAuth accepts requests with the correct bearer key', () => {
    let called = false
    const handler = needsAuth((_c, r) => {
        called = true
        r.writeHead(200)
        r.end('ok')
    })
    const res = mockRes()
    handler(ctx({headers: {authorization: 'Bearer secret'}}), res)
    assert.equal(res.captured.statusCode, 200)
    assert.equal(res.captured.body, 'ok')
    assert.equal(called, true)
})
