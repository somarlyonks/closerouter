import {Config, ModelConfig, ModelEntry, ProviderConfig} from './config'

export interface Route {
    // the raw id
    id: string
    provider: string
    config: ProviderConfig
    entry: ModelEntry
}

export class Router {
    private providers: string[]
    private modelMap: Map<string, Route> = new Map()

    constructor (config: Config) {
        this.providers = [...Object.keys(config.providers)]
        for (const [provider, providerConfig] of Object.entries(config.providers)) {
            for (const model of providerConfig.models || []) {
                const id = typeof model === 'string' ? model : model.id
                const entry = normalizeModel(provider, model)
                this.modelMap.set(entry.id, {
                    id,
                    provider,
                    config: providerConfig,
                    entry,
                })
            }
        }
    }

    lookup (model: string): Route | undefined {
        return this.modelMap.get(model)
    }

    listProviders (): {name: string, models: string[]}[] {
        return this.providers.map(name => ({
            name,
            models: [...this.modelMap.values()].filter(r => r.provider === name).map(m => m.id),
        }))
    }

    listModels (): ModelEntry[] {
        const models = [...this.modelMap.values()].map(r => r.entry)
        return JSON.parse(JSON.stringify(models))
    }
}

function normalizeModel (provider: string, model: ModelConfig): ModelEntry {
    const props: ModelEntry = typeof model === 'string' ? {id: ''} : {...model}
    props.id = `${provider}/${typeof model === 'string' ? model : model.id}`
    props.owned_by = props.owned_by || provider
    return props
}
