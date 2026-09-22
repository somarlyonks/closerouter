import {test} from 'node:test'
import assert from 'node:assert/strict'
import {router, withMethod, needsAuth, handle, method, path} from '../lib/router'
import type {RequestContext, Route} from '../lib/router'
import {mockReq, mockRes, sampleConfig} from './helpers'

function ctx (opts: {method?: string, url?: string, headers?: Record<string, string>} = {}): RequestContext {
    return {
        req: mockReq(opts),
        env: {config: sampleConfig({key: 'secret'})},
    }
}

test('router runs the first matching route in registration order', () => {
    const h = router(
        () => true,
        (_c, r) => {
            r.writeHead(200)
            r.end('first')
        },
        router(
            () => true,
            (_c, r) => {
                r.writeHead(200)
                r.end('second')
            },
        ),
    )
    const res = mockRes()
    handle(h)(ctx(), res)
    assert.equal(res.captured.statusCode, 200)
    assert.equal(res.captured.body, 'first')
})

test('router falls through to the cont when the head predicate does not match', () => {
    const h = router(
        () => false,
        (_c, r) => {
            r.writeHead(200)
            r.end('first')
        },
        router(
            () => true,
            (_c, r) => {
                r.writeHead(200)
                r.end('second')
            },
        ),
    )
    const res = mockRes()
    handle(h)(ctx(), res)
    assert.equal(res.captured.statusCode, 200)
    assert.equal(res.captured.body, 'second')
})

test('router collects the composition as an ordered route list', () => {
    const inner: Route[] = router(
        () => true,
        (_c, r) => {
            r.writeHead(200)
            r.end('inner')
        },
    )
    const h = router(
        () => false,
        (_c, r) => {
            r.writeHead(200)
            r.end('outer')
        },
        inner,
    )
    // the head route is followed by the inner router's routes verbatim
    assert.equal(h.length, inner.length + 1)
    assert.equal(h[0]!.predicate(ctx()), false)
    assert.equal(h[1], inner[0])
    assert.equal(h[2], inner[1])
})

test('router executes a nested router in the handler position', () => {
    const nested = router(
        () => false,
        (_c, r) => {
            r.writeHead(200)
            r.end('nested head')
        },
        (_c, r) => {
            r.writeHead(200)
            r.end('nested tail')
        },
    )
    const h = router(() => true, nested)
    const res = mockRes()
    handle(h)(ctx(), res)
    assert.equal(res.captured.statusCode, 200)
    assert.equal(res.captured.body, 'nested tail')
})

test('router answers 404 from a nested router that matches nothing', () => {
    const nested = router(() => false, (_c, r) => {
        r.writeHead(200)
        r.end('never')
    })
    const h = router(() => true, nested)
    const res = mockRes()
    handle(h)(ctx({method: 'GET', url: '/x'}), res)
    assert.equal(res.captured.statusCode, 404)
})

test('router treats a plain handler cont as a catch-all tail', () => {
    const h = router(
        () => false,
        (_c, r) => {
            r.writeHead(200)
            r.end('nope')
        },
        (_c, r) => {
            r.writeHead(200)
            r.end('caught')
        },
    )
    const res = mockRes()
    handle(h)(ctx(), res)
    assert.equal(res.captured.statusCode, 200)
    assert.equal(res.captured.body, 'caught')
    // the catch-all is part of the collected routes
    assert.equal(h.length, 2)
})

test('router falls to 404 when no route matches and no cont is given', () => {
    const h = router(() => false, (_c, r) => {
        r.writeHead(200)
        r.end('hit')
    })
    const res = mockRes()
    handle(h)(ctx({method: 'POST', url: '/missing'}), res)
    assert.equal(res.captured.statusCode, 404)
    assert.match(res.captured.body, /Not found: POST \/missing/)
})

test('withMethod answers 405 with its own allow method, else runs the handler', () => {
    const h = withMethod('GET')((_c, r) => {
        r.writeHead(200)
        r.end('get')
    })
    const denied = mockRes()
    handle(h)(ctx({method: 'POST', url: '/x'}), denied)
    assert.equal(denied.captured.statusCode, 405)
    assert.equal(denied.captured.headers['allow'], 'GET')
    assert.match(denied.captured.body, /Method not allowed: POST \/x/)

    const allowed = mockRes()
    handle(h)(ctx({method: 'GET', url: '/x'}), allowed)
    assert.equal(allowed.captured.statusCode, 200)
    assert.equal(allowed.captured.body, 'get')
})

test('withMethod accepts a router handler', () => {
    const h = withMethod('GET')(router(
        () => true,
        (_c, r) => {
            r.writeHead(200)
            r.end('get')
        },
    ))
    const denied = mockRes()
    handle(h)(ctx({method: 'POST', url: '/x'}), denied)
    assert.equal(denied.captured.statusCode, 405)
    assert.equal(denied.captured.headers['allow'], 'GET')

    const allowed = mockRes()
    handle(h)(ctx({method: 'GET', url: '/x'}), allowed)
    assert.equal(allowed.captured.statusCode, 200)
    assert.equal(allowed.captured.body, 'get')
})

test('needsAuth gates handlers with the bearer key', () => {
    const gated = needsAuth((_c, r) => {
        r.writeHead(200)
        r.end('ok')
    })
    const denied = mockRes()
    handle(gated)(ctx({headers: {}}), denied)
    assert.equal(denied.captured.statusCode, 401)
    assert.match(denied.captured.body, /authentication_error/)

    const allowed = mockRes()
    handle(gated)(ctx({headers: {authorization: 'Bearer secret'}}), allowed)
    assert.equal(allowed.captured.statusCode, 200)
    assert.equal(allowed.captured.body, 'ok')
})

test('needsAuth accepts a router handler', () => {
    const gated = needsAuth(router(
        () => true,
        (_c, r) => {
            r.writeHead(200)
            r.end('ok')
        },
    ))
    const denied = mockRes()
    handle(gated)(ctx({headers: {}}), denied)
    assert.equal(denied.captured.statusCode, 401)
    assert.match(denied.captured.body, /authentication_error/)

    const allowed = mockRes()
    handle(gated)(ctx({headers: {authorization: 'Bearer secret'}}), allowed)
    assert.equal(allowed.captured.statusCode, 200)
    assert.equal(allowed.captured.body, 'ok')
})

test('method siblings in one list aggregate into one allow header', () => {
    const h = router(
        method('GET'),
        (_c, r) => {
            r.writeHead(200)
            r.end('get')
        },
        withMethod('POST')((_c, r) => {
            r.writeHead(200)
            r.end('post')
        }),
    )
    const res = mockRes()
    handle(h)(ctx({method: 'DELETE', url: '/x'}), res)
    assert.equal(res.captured.statusCode, 405)
    assert.equal(res.captured.headers['allow'], 'GET, POST')
    assert.match(res.captured.body, /Method not allowed: DELETE \/x/)
})

test('a method mismatch falls through to a matching sibling', () => {
    const h = router(
        method('GET'),
        (_c, r) => {
            r.writeHead(200)
            r.end('get')
        },
        withMethod('POST')((_c, r) => {
            r.writeHead(200)
            r.end('post')
        }),
    )
    const res = mockRes()
    handle(h)(ctx({method: 'POST', url: '/x'}), res)
    assert.equal(res.captured.statusCode, 200)
    assert.equal(res.captured.body, 'post')
})

test('aggregated method mismatches outrank the catch-all fallback', () => {
    // the /status shape: a method route whose continuation is the default 404
    const h = router(
        method('GET'),
        (_c, r) => {
            r.writeHead(200)
            r.end('get')
        },
    )
    const denied = mockRes()
    handle(h)(ctx({method: 'POST', url: '/x'}), denied)
    assert.equal(denied.captured.statusCode, 405)
    assert.equal(denied.captured.headers['allow'], 'GET')

    const allowed = mockRes()
    handle(h)(ctx({method: 'GET', url: '/x'}), allowed)
    assert.equal(allowed.captured.statusCode, 200)
})

test('a path route owns its subtree: exhaustion answers there', () => {
    // the /v1 shape: /v1/models is GET-only, while a later sibling proxies
    // POSTs for every other /v1 path
    const h = router(
        path('/v1/models'),
        withMethod('GET')((_c, r) => {
            r.writeHead(200)
            r.end('get')
        }),
        withMethod('POST')((_c, r) => {
            r.writeHead(200)
            r.end('post')
        }),
    )
    // POST and DELETE /v1/models never fall through to the POST sibling
    for (const m of ['POST', 'DELETE']) {
        const denied = mockRes()
        handle(h)(ctx({method: m, url: '/v1/models'}), denied)
        assert.equal(denied.captured.statusCode, 405, m)
        assert.equal(denied.captured.headers['allow'], 'GET', m)
    }

    // but the sibling still serves every other path
    const proxied = mockRes()
    handle(h)(ctx({method: 'POST', url: '/v1/chat/completions'}), proxied)
    assert.equal(proxied.captured.statusCode, 200)
    assert.equal(proxied.captured.body, 'post')
})

test('a matched route guards its fallbacks from outer method mismatches', () => {
    // the /config shape: PUT matches, but auth fails inside the branch - the
    // GET mismatch recorded by the earlier sibling must not suppress the 401
    const h = router(
        method('GET'),
        withMethod('GET')((_c, r) => {
            r.writeHead(200)
            r.end('get')
        }),
        withMethod('PUT')(needsAuth((_c, r) => {
            r.writeHead(200)
            r.end('put')
        })),
    )
    const denied = mockRes()
    handle(h)(ctx({method: 'PUT', url: '/config', headers: {}}), denied)
    assert.equal(denied.captured.statusCode, 401)

    const allowed = mockRes()
    handle(h)(ctx({method: 'PUT', url: '/config', headers: {authorization: 'Bearer secret'}}), allowed)
    assert.equal(allowed.captured.statusCode, 200)
    assert.equal(allowed.captured.body, 'put')
})

test('method factory carries its method and matches only that method', () => {
    const head = method('GET')
    assert.equal(head.method, 'GET')
    assert.equal(head.predicate(ctx({method: 'GET', url: '/x'})), true)
    assert.equal(head.predicate(ctx({method: 'POST', url: '/x'})), false)
})

test('path patterns match the pathname: exact, raw-prefix, and subtree', () => {
    assert.equal(path('/status').pattern, '/status')
    assert.equal(path('/status').predicate(ctx({url: '/status'})), true)
    // query strings are ignored
    assert.equal(path('/status').predicate(ctx({url: '/status?x=1'})), true)
    assert.equal(path('/status').predicate(ctx({url: '/status/1'})), false)

    // trailing * is a raw pathname prefix: /v1/* matches /v1/models but not bare /v1
    assert.equal(path('/v1/*').predicate(ctx({url: '/v1/models'})), true)
    assert.equal(path('/v1/*').predicate(ctx({url: '/v1'})), false)
    assert.equal(path('/v1/*').predicate(ctx({url: '/v1x'})), false)
    // URL pathname parsing canonicalizes raw and encoded dot segments
    assert.equal(path('/v1/*').predicate(ctx({url: '/../v1/models'})), true)
    assert.equal(path('/v1/*').predicate(ctx({url: '/%2e%2e/v1/models'})), true)

    // trailing @* is the path itself plus everything below it - and only real
    // segments: /usage@* does not match a path like /usage_but_does_not_exist
    assert.equal(path('/logs@*').predicate(ctx({url: '/logs'})), true)
    assert.equal(path('/logs@*').predicate(ctx({url: '/logs/1'})), true)
    assert.equal(path('/logs@*').predicate(ctx({url: '/logs?x=1'})), true)
    assert.equal(path('/logs@*').predicate(ctx({url: '/logsfoo'})), false)
    assert.equal(path('/usage@*').predicate(ctx({url: '/usage'})), true)
    assert.equal(path('/usage@*').predicate(ctx({url: '/usage/1'})), true)
    assert.equal(path('/usage@*').predicate(ctx({url: '/usage_but_does_not_exist'})), false)
})
