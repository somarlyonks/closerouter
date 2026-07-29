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
