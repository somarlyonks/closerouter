import type {Api, Model} from '@earendil-works/pi-ai'
import {getBuiltinModels} from '@earendil-works/pi-ai/providers/all'
import type {ProviderModelConfig} from '@earendil-works/pi-coding-agent'
import {asRecord, booleanField, integerField, numberField, stringField} from './values.ts'

// closerouter only exposes chat models; Extract narrows pi's union to that variant.
export type ChatModel = Extract<ProviderModelConfig, {reasoning: boolean}>

/** The APIs closerouter serves and pi streams natively. */
export type CloserouterApi = 'openai-completions' | 'openai-responses'

/** Used when neither a settings entry nor pi's catalog picks an API. */
export const DEFAULT_API: CloserouterApi = 'openai-completions'

export function isCloserouterApi (api: string | undefined): api is CloserouterApi {
    return api === 'openai-completions' || api === 'openai-responses'
}

/**
 * Fields a settings entry may override. `api` is limited to what closerouter
 * serves. `$alias` names a `<provider>/<model>` id in pi's catalog whose spec an
 * otherwise-unknown provider's model inherits.
 */
export type ModelOverride = Partial<Omit<ChatModel, 'id' | 'api' | 'baseUrl' | 'type'>> & {api?: CloserouterApi, $alias?: string}

// getBuiltinModels is typed for pi's literal provider ids; closerouter reports a
// runtime string, so widen the lookup.
const builtinModels = getBuiltinModels as unknown as (provider: string) => Array<Model<Api>>

// Values closerouter cannot report for an OpenAI-compatible model.
const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 16384
const ZERO_COST = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}

export interface ListedModel {
    [key: string]: unknown
    id: string
}

export function parseListedModels (body: unknown): ListedModel[] {
    const data = asRecord(body)?.data
    if (!Array.isArray(data)) return []
    return data.filter(isListedModel)
}

function isListedModel (entry: unknown): entry is ListedModel {
    const id = asRecord(entry)?.id
    return typeof id === 'string' && id.length > 0
}

export function toProviderModel (entry: ListedModel, override: ModelOverride | undefined): ChatModel {
    const options = overrideFields(override)
    const spec = findCatalogSpec(stringField(asRecord(override), '$alias') ?? entry.id)
    // Only a catalog entry closerouter can actually serve may contribute wire
    // details: another API (anthropic-messages, google-generative-ai, ...) would
    // make pi send a body and headers closerouter cannot relay.
    const wireSpec = spec && isCloserouterApi(spec.api) ? spec : undefined

    const thinkingLevelMap = options.thinkingLevelMap ?? wireSpec?.thinkingLevelMap
    return {
        id: entry.id,
        api: options.api ?? wireSpec?.api ?? DEFAULT_API,
        name: options.name ?? spec?.name ?? entry.id,
        reasoning: options.reasoning ?? spec?.reasoning ?? booleanField(entry, 'reasoning', 'supports_reasoning') ?? false,
        input: options.input ?? spec?.input ?? inferInput(entry),
        contextWindow: options.contextWindow
            ?? spec?.contextWindow
            ?? integerField(entry, 'context_window', 'contextWindow', 'context_length', 'contextLength', 'max_input_tokens')
            ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: options.maxTokens
            ?? spec?.maxTokens
            ?? integerField(entry, 'max_tokens', 'maxTokens', 'max_output_tokens')
            ?? DEFAULT_MAX_TOKENS,
        cost: options.cost ?? spec?.cost ?? inferCost(entry),
        ...(thinkingLevelMap ? {thinkingLevelMap} : {}),
        ...(wireSpec?.compat ? {compat: wireSpec.compat} : {}),
        ...options,
    }
}

// overrideFields drops the fields the plugin owns, so a settings entry cannot
// redirect the request away from closerouter.
function overrideFields (override: ModelOverride | undefined): ModelOverride {
    const fields = {...(override ?? {})} as Record<string, unknown>
    delete fields.id
    delete fields.baseUrl
    delete fields.type
    delete fields.$alias
    return fields as ModelOverride
}

// findCatalogSpec matches pi's own catalog by the `<provider>/<model>` id
// closerouter reports, e.g. `deepseek/deepseek-flash` or
// `openrouter/anthropic/claude-sonnet-4.5`.
function findCatalogSpec (id: string): Model<Api> | undefined {
    const slash = id.indexOf('/')
    if (slash <= 0 || slash === id.length - 1) return undefined
    return builtinModels(id.slice(0, slash)).find(model => model.id === id.slice(slash + 1))
}

function inferInput (entry: Record<string, unknown>): Array<'text' | 'image'> {
    if (Array.isArray(entry.input)) {
        const input = entry.input.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
        if (input.length > 0) return input
    }
    const capabilities = asRecord(entry.capabilities)
    const sees = booleanField(entry, 'vision', 'supports_vision')
        ?? booleanField(capabilities, 'image', 'vision')
    return sees ? ['text', 'image'] : ['text']
}

function inferCost (entry: Record<string, unknown>): {input: number, output: number, cacheRead: number, cacheWrite: number} {
    const cost = asRecord(entry.cost)
    if (cost) {
        return {
            input: numberField(cost, 'input') ?? 0,
            output: numberField(cost, 'output') ?? 0,
            cacheRead: numberField(cost, 'cacheRead') ?? 0,
            cacheWrite: numberField(cost, 'cacheWrite') ?? 0,
        }
    }
    // OpenRouter-style pricing is per token; pi's cost is per million.
    const pricing = asRecord(entry.pricing)
    if (pricing) {
        return {
            input: perMillion(pricing.prompt),
            output: perMillion(pricing.completion),
            cacheRead: perMillion(pricing.input_cache_read ?? pricing.cache_read),
            cacheWrite: 0,
        }
    }
    return {...ZERO_COST}
}

function perMillion (value: unknown): number {
    const price = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
    return Number.isFinite(price) ? price * 1_000_000 : 0
}
