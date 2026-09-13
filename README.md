# CloseRouter

Simple and slim AI gateway, it just works!

## Usage

Looks for `closerouter.json` as config at the current working directory by default. Pass `-c`/`--config <path>` to use a different config file.

```
closerouter - LLM proxy/router

Usage:
  closerouter [server] [-c|--config <path>] [-d|--detach]   Start the proxy server
  closerouter test [-c <path>] | [<json>]                   Test a config (JSON string or file via -c)
  closerouter help                                          Show this help
  closerouter version                                       Show the version

Options:
  -c, --config <path>   Path to config file (default: closerouter.json)
  -d, --detach          Run the server in the background
```

API endpoint: `http://localhost:6712/v1`

## Configuration

Consider use a [$schema](https://raw.githubusercontent.com/somarlyonks/closerouter/refs/heads/master/lib/config/schema.json) in your config.
