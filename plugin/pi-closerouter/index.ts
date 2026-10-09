import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import type {ExtensionAPI, ProviderConfig} from '@earendil-works/pi-coding-agent'
import {resolveSettings, type CloserouterSettings, type ConfiguredModel} from './config.ts'
import {parseListedModels, toProviderModel, DEFAULT_API, type ChatModel, type ListedModel} from './models.ts'

const PROVIDER_ID = 'closerouter'
const REQUEST_TIMEOUT_MS = 5000

export async function discoverModels (
    settings: CloserouterSettings,
    signal?: AbortSignal,
): Promise<ChatModel[]> {
    const response = await fetch(`${settings.baseUrl}/models`, {
        headers: {authorization: `Bearer ${settings.apiKey}`},
        signal: withTimeout(signal),
    })
    if (!response.ok) throw new Error(`closerouter GET /v1/models answered ${response.status}`)
    return resolveModels(settings.models, parseListedModels(await response.json()))
}

// resolveModels turns the configured models into provider models. With no
// configured models every listed model is exposed; otherwise the configuration
// is authoritative, so a model the gateway does not report is still exposed from
// its settings entry and defaults rather than dropping out silently.
export function resolveModels (configured: ConfiguredModel[], listed: ListedModel[]): ChatModel[] {
    if (configured.length === 0) return listed.map(entry => toProviderModel(entry, undefined))
    const byId = new Map(listed.map(entry => [entry.id, entry]))
    return configured.map(model => toProviderModel(byId.get(model.id) ?? {id: model.id}, model))
}

// warmModels discovers the current models and hands them to the caller. It is
// invoked without awaiting so the factory never blocks startup on the gateway,
// and its result is applied once loading has finished.
export async function warmModels (
    settings: CloserouterSettings,
    apply: (models: ChatModel[]) => void,
): Promise<void> {
    apply(await discoverModels(settings))
}

export function providerConfig (settings: CloserouterSettings, models: ChatModel[] = []): ProviderConfig {
    let cached = models
    return {
        name: 'closerouter',
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        api: DEFAULT_API,
        models: cached,
        async refreshModels (context) {
            if (context.allowNetwork) cached = await discoverModels(settings, context.signal)
            return cached
        },
    }
}

export default function registerCloserouter (pi: ExtensionAPI): void {
    const settings = resolveSettings({
        env: process.env,
        cwd: process.cwd(),
        homeDir: homedir(),
        readText: readTextFile,
    })

    // Registered synchronously with no network so startup selection and
    // `pi --list-models` never wait on the gateway. The configured models are
    // seeded from settings so a resumed session can restore a closerouter model
    // during pi's offline startup refresh; warmModels then merges the gateway's
    // reported metadata over them.
    pi.registerProvider(PROVIDER_ID, providerConfig(settings, resolveModels(settings.models, [])))

    // Refresh in the background and re-register with the result. registerProvider
    // applies immediately once loading is done, so cold start stays instant.
    void warmModels(settings, models => pi.registerProvider(PROVIDER_ID, providerConfig(settings, models)))
        .catch(() => {})
}

function withTimeout (signal: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function readTextFile (filePath: string): string | undefined {
    try {
        return readFileSync(filePath, 'utf8')
    } catch {
        return undefined
    }
}
