import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'fs'
import {validateSchema, applySchemaDefaults, type JSONSchema, type SchemaIssue} from '../lib/config/json-schema'

const schema: JSONSchema = JSON.parse(readFileSync('lib/config/schema.json', 'utf-8'))

function validate (value: unknown, schemaOverride?: JSONSchema): SchemaIssue[] {
    return validateSchema(schemaOverride ?? schema, value)
}

function messages (issues: SchemaIssue[]): string[] {
    return issues.map(issue => (issue.path ? `${issue.path} ${issue.message}` : issue.message))
}

test('accepts a complete valid config', () => {
    const issues = validate({
        $schema: 'https://example.com/schema.json',
        port: 8080,
        key: 'sk-x',
        db: '/var/lib/closerouter.db',
        retentionDays: 30,
        providers: {
            mock: {
                base_url: 'http://127.0.0.1:9999',
                api_key: 'k',
                models: ['mock-1', {id: 'mock-2', owned_by: 'mock'}],
            },
        },
    })
    assert.deepEqual(issues, [])
})

test('accepts a minimal valid config (defaults live in the schema, not the validator)', () => {
    const issues = validate({providers: {p: {base_url: 'http://x', api_key: 'k'}}})
    assert.deepEqual(issues, [])
})

test('rejects a non-object root', () => {
    assert.deepEqual(messages(validate('nope')), ['must be an object'])
})

test('rejects unknown top-level properties (additionalProperties: false)', () => {
    const issues = validate({providers: {}, pruvders: {}})
    assert.deepEqual(messages(issues).filter(m => m.includes('pruvders')), ['pruvders is not an allowed property'])
})

test('reports missing required properties with paths', () => {
    const issues = validate({})
    assert.deepEqual(messages(issues), ['providers is required but missing'])
})

test('validates port type, range, and integer-ness', () => {
    assert.deepEqual(messages(validate({port: '8080', providers: {p: {base_url: 'http://x', api_key: 'k'}}})), ['port must be an integer'])
    assert.deepEqual(messages(validate({port: 6712.5, providers: {p: {base_url: 'http://x', api_key: 'k'}}})), ['port must be an integer'])
    assert.deepEqual(messages(validate({port: 0, providers: {p: {base_url: 'http://x', api_key: 'k'}}})), ['port must be a number between 1 and 65535'])
    assert.deepEqual(messages(validate({port: 65536, providers: {p: {base_url: 'http://x', api_key: 'k'}}})), ['port must be a number between 1 and 65535'])
})

test('validates minimum and maximum together', () => {
    const s: JSONSchema = {type: 'integer', minimum: 1, maximum: 10}
    assert.deepEqual(messages(validateSchema(s, 5)), [])
    assert.deepEqual(messages(validateSchema(s, 50)), ['must be a number between 1 and 10'])
})

test('validates key minLength', () => {
    const base = {providers: {p: {base_url: 'http://x', api_key: 'k'}}}
    assert.deepEqual(messages(validate({...base, key: ''})), ['key must be at least 1 character long'])
    assert.deepEqual(messages(validate({...base, key: 'k'})), [])
})

test('validates db via oneOf: path string, false ok; other values rejected', () => {
    const base = {providers: {p: {base_url: 'http://x', api_key: 'k'}}}
    assert.deepEqual(messages(validate({...base, db: 'test.db'})), [])
    assert.deepEqual(messages(validate({...base, db: false})), [])
    const empty = messages(validate({...base, db: ''}))
    assert.equal(empty.length, 1)
    assert.match(empty[0], /^db must match one of the allowed shapes \(must be at least 1 character long; must be a boolean\)$/)
    const bad = messages(validate({...base, db: true}))
    assert.equal(bad.length, 1)
    assert.match(bad[0], /^db must match one of the allowed shapes \(/)
})

test('validates retentionDays minimum 0 and integer type', () => {
    const base = {providers: {p: {base_url: 'http://x', api_key: 'k'}}}
    assert.deepEqual(messages(validate({...base, retentionDays: -1})), ['retentionDays must be a number >= 0'])
    assert.deepEqual(messages(validate({...base, retentionDays: 1.5})), ['retentionDays must be an integer'])
})

test('validates $schema format uri', () => {
    const base = {providers: {p: {base_url: 'http://x', api_key: 'k'}}}
    assert.deepEqual(messages(validate({...base, $schema: 'not a uri'})), ['$schema must be a valid URI'])
    assert.deepEqual(messages(validate({...base, $schema: 'https://json-schema.org/draft/2020-12/schema'})), [])
})

test('providers must be an object with minProperties 1', () => {
    assert.deepEqual(messages(validate({providers: []})), ['providers must be an object'])
    assert.deepEqual(messages(validate({providers: {}})), ['providers must have at least 1 property'])
})

test('validates provider entries through additionalProperties $ref', () => {
    const issues = validate({providers: {mock: {api_key: 'k'}}})
    assert.deepEqual(messages(issues), ['providers.mock.base_url is required but missing'])

    const missingKey = validate({providers: {mock: {base_url: 'http://x'}}})
    assert.deepEqual(messages(missingKey), ['providers.mock.api_key is required but missing'])

    const extra = validate({providers: {mock: {base_url: 'http://x', api_key: 'k', extra: 1}}})
    assert.deepEqual(messages(extra), ['providers.mock.extra is not an allowed property'])
})

test('Object.prototype names are treated as ordinary JSON properties', () => {
    for (const name of ['toString', 'constructor', '__proto__']) {
        const config = JSON.parse(`{"providers":{"${name}":42}}`)
        assert.deepEqual(messages(validate(config)), [`providers.${name} must be an object`])
    }

    const extra = JSON.parse('{"providers":{"p":{"base_url":"http://x","api_key":"k"}},"toString":1}')
    assert.deepEqual(messages(validate(extra)), ['toString is not an allowed property'])
})

test('validates provider base_url as uri', () => {
    const provider = (base_url: string) => ({providers: {mock: {base_url, api_key: 'k'}}})
    assert.deepEqual(messages(validate(provider('no-scheme'))), ['providers.mock.base_url must be a valid URI'])
    assert.deepEqual(messages(validate(provider('http://['))), ['providers.mock.base_url must be a valid URI'])
    assert.deepEqual(messages(validate(provider('http://'))), ['providers.mock.base_url must be a valid URI'])
})

test('validates models array items against the model $ref oneOf', () => {
    const provider = (models: unknown[]) => ({providers: {p: {base_url: 'http://x', api_key: 'k', models}}})

    assert.deepEqual(messages(validate(provider(['bare-id']))), [])
    assert.deepEqual(messages(validate(provider([{id: 'obj-id', owned_by: 'p'}]))), [])

    const emptyString = validate(provider(['']))
    assert.deepEqual(messages(emptyString), [
        'providers.p.models[0] must match one of the allowed shapes (must be at least 1 character long; must be an object)',
    ])

    const noId = validate(provider([{name: 'no-id'}]))
    assert.deepEqual(messages(noId), ['providers.p.models[0] must match one of the allowed shapes (must be a string; providers.p.models[0].id is required but missing)'])

    const number = validate(provider([7]))
    assert.deepEqual(messages(number), ['providers.p.models[0] must match one of the allowed shapes (must be a string; must be an object)'])

    const nonArray = validate({providers: {p: {base_url: 'http://x', api_key: 'k', models: 'mock-1'}}})
    assert.deepEqual(messages(nonArray), ['providers.p.models must be an array'])
})

test('collects multiple independent issues in one pass', () => {
    const issues = validate({
        port: 99999,
        key: '',
        providers: {
            a: {base_url: 'nope', api_key: 'k'},
            b: {base_url: 'http://x'},
        },
    })
    assert.deepEqual(messages(issues), [
        'port must be a number between 1 and 65535',
        'key must be at least 1 character long',
        'providers.a.base_url must be a valid URI',
        'providers.b.api_key is required but missing',
    ])
})

test('resolves nested local $ref chains', () => {
    const s: JSONSchema = {
        $defs: {
            inner: {type: 'string', minLength: 2},
            outer: {$ref: '#/$defs/inner'},
        },
        type: 'object',
        properties: {value: {$ref: '#/$defs/outer'}},
    }
    assert.deepEqual(messages(validateSchema(s, {value: 'ok'})), [])
    assert.deepEqual(messages(validateSchema(s, {value: 'x'})), ['value must be at least 2 characters long'])
})

test('reports unresolvable refs instead of throwing', () => {
    const s: JSONSchema = {type: 'object', properties: {value: {$ref: '#/$defs/nope'}}}
    assert.deepEqual(messages(validateSchema(s, {value: 1})), ['value unresolvable schema reference #/$defs/nope'])

    const inherited = JSON.parse('{"$ref":"#/$defs/__proto__","$defs":{}}')
    assert.deepEqual(messages(validateSchema(inherited, 1)), ['unresolvable schema reference #/$defs/__proto__'])
})

test('a cyclic $ref hits the depth cap instead of recursing forever', () => {
    const s: JSONSchema = {$ref: '#/$defs/loop', $defs: {loop: {$ref: '#/$defs/loop'}}}
    assert.deepEqual(messages(validateSchema(s, 'anything')), ['schema recursion limit exceeded'])
})

test('enum compares JSON values structurally', () => {
    const s: JSONSchema = {enum: [false, ['a', 'b'], {x: 1}]}
    assert.deepEqual(messages(validateSchema(s, false)), [])
    assert.deepEqual(messages(validateSchema(s, ['a', 'b'])), [])
    assert.deepEqual(messages(validateSchema(s, {x: 1})), [])
    assert.deepEqual(messages(validateSchema(s, true)), ['must be one of: false, ["a","b"], {"x":1}'])
    assert.deepEqual(messages(validateSchema(s, 0)), ['must be one of: false, ["a","b"], {"x":1}'])

    const inherited = JSON.parse('{"enum":[{"__proto__":{}}]}')
    assert.deepEqual(messages(validateSchema(inherited, {x: 1})), ['must be one of: {"__proto__":{}}'])
})

test('type arrays accept any listed type', () => {
    const s: JSONSchema = {type: ['string', 'null']}
    assert.deepEqual(messages(validateSchema(s, null)), [])
    assert.deepEqual(messages(validateSchema(s, 'x')), [])
    assert.deepEqual(messages(validateSchema(s, 5)), ['must be a string or null'])
})

test('oneOf rejects values matching multiple branches', () => {
    const s: JSONSchema = {oneOf: [{type: 'number'}, {type: 'number', minimum: 0}]}
    assert.deepEqual(messages(validateSchema(s, 5)), ['matches more than one allowed shape (2 of 2)'])
})

test('$ref and oneOf compose with sibling constraints', () => {
    const refSchema: JSONSchema = {
        $defs: {text: {type: 'string'}},
        $ref: '#/$defs/text',
        minLength: 3,
    }
    assert.deepEqual(messages(validateSchema(refSchema, 'x')), ['must be at least 3 characters long'])

    const oneOfSchema: JSONSchema = {
        oneOf: [{type: 'string'}, {type: 'number'}],
        minLength: 3,
    }
    assert.deepEqual(messages(validateSchema(oneOfSchema, 'x')), ['must be at least 3 characters long'])
})

test('additionalProperties as a schema validates unmapped keys', () => {
    const s: JSONSchema = {
        type: 'object',
        properties: {known: {type: 'string'}},
        additionalProperties: {type: 'integer'},
    }
    assert.deepEqual(messages(validateSchema(s, {known: 'x', extra: 3})), [])
    assert.deepEqual(messages(validateSchema(s, {known: 'x', extra: 'nope'})), ['extra must be an integer'])
})

test('applySchemaDefaults inserts declared defaults for missing properties', () => {
    const defaults = applySchemaDefaults(schema, {providers: {p: {base_url: 'http://x', api_key: 'k'}}})
    assert.deepEqual(defaults, {
        port: 6712,
        key: 'sk-cr-kee9itsecr1t',
        db: 'closerouter.db',
        retentionDays: 7,
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
})

test('applySchemaDefaults keeps present values and never invents others', () => {
    const value = {port: 9999, db: false, providers: {p: {base_url: 'http://x', api_key: 'k'}}}
    const defaulted = applySchemaDefaults(schema, value)
    assert.deepEqual(defaulted, {
        port: 9999,
        key: 'sk-cr-kee9itsecr1t',
        db: false,
        retentionDays: 7,
        providers: {p: {base_url: 'http://x', api_key: 'k'}},
    })
    // no in-place mutation of the input
    assert.equal('port' in value, true)
    assert.equal('key' in value, false)
})

test('applySchemaDefaults preserves Object.prototype-named properties', () => {
    const s: JSONSchema = {
        type: 'object',
        properties: {
            toString: {default: 'defaulted'},
        },
    }
    const defaulted = applySchemaDefaults(s, JSON.parse('{"__proto__":{"safe":true}}')) as Record<string, unknown>
    assert.equal(Object.prototype.hasOwnProperty.call(defaulted, 'toString'), true)
    assert.equal(defaulted.toString, 'defaulted')
    assert.equal(Object.prototype.hasOwnProperty.call(defaulted, '__proto__'), true)
    assert.deepEqual(defaulted.__proto__, {safe: true})
})

test('applySchemaDefaults recurses through $ref and preserves falsey defaults', () => {
    const s: JSONSchema = {
        type: 'object',
        properties: {
            thing: {
                $ref: '#/$defs/thing',
            },
            flag: {
                default: false,
            },
        },
        $defs: {
            thing: {
                type: 'object',
                properties: {
                    inner: {default: 0},
                    nested: {
                        type: 'object',
                        properties: {deep: {default: 'x'}},
                    },
                },
            },
        },
    }
    const defaulted = applySchemaDefaults(s, {thing: {nested: {}}, other: 1})
    assert.deepEqual(defaulted, {
        thing: {inner: 0, nested: {deep: 'x'}},
        flag: false,
        other: 1,
    })
})
