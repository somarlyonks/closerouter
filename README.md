# CloseRouter

Simple and slim.

## Usage

Always looking for `closerouter.json` as config at the same path to the executable.

```
closerouter — LLM proxy/router

Usage:
  closerouter [server] [-d|--detach]                 Start the proxy server
  closerouter help                                   Show this help
  closerouter providers                              List configured providers
  closerouter models <provider>                      List provider's models to add
              models <provider> pick [<model>...]    Add specific model(s) to config
```

API endpoint: `http://localhost:6712/v1`

## Configuration

Consider use a [$schema](https://raw.githubusercontent.com/somarlyonks/closerouter/refs/heads/master/closerouter-schema.json) at your config, or take the type as a hint, if you'd prefer

```typescript
interface Config {
    port?: number
    key?: string
    providers: Record<string, {
        base_url: string
        api_key: string
        models?: Array<string | {id: string}>
    }>
}
```
