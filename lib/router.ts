import {Config, ProviderConfig} from './config'

export interface Route {
    provider: string
    config: ProviderConfig
}

export class Router {
    private modelMap: Map<string, Route> = new Map()

    constructor (config: Config) {
        for (const [name, provider] of Object.entries(config.providers)) {
            for (const model of provider.models) {
                this.modelMap.set(model, {provider: `${name}/${model}`, config: provider})
            }
        }
    }

    lookup (model: string): Route | undefined {
        return this.modelMap.get(model)
    }

    listModels (): string[] {
        const models = [...this.modelMap.keys()]
        return JSON.parse(JSON.stringify(models))
    }
}
