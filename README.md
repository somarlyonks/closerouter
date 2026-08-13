# CloseRouter

Simple and slim AI gateway, it just works!

## Usage

Always looking for `closerouter.json` as config at current working directory.

```
closerouter — LLM proxy/router

Usage:
  closerouter [server] [-d|--detach]                 Start the proxy server
  closerouter help                                   Show this help
  closerouter version                                Show the version
```

API endpoint: `http://localhost:6712/v1`

Live logs at: `http://localhost:6712/logs`

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
