# AGENTS instructions

## Project Overview

`closerouter` is a lightweight, zero-dependency LLM proxy/router that exposes an OpenAI-compatible API and forwards requests to multiple backend providers based on the model name. It compiles to a native executable via `scriptc`.

## Key Constraints

- **Zero runtime dependencies** — use only Node.js built-in modules.
- **Compiled via `scriptc`** — the project is built with `scriptc`, which compiles TypeScript to a native binary. Keep code compatible with whatever Node.js API surface `scriptc` supports.
- **JSON config only** — no YAML, TOML, or other formats. Config file is `closerouter.json` by default.
- **Streaming is critical** — `/v1/chat/completions` must support SSE streaming. Proxy responses should stream chunks back to the client without buffering the entire response.
- **OpenAI-format only** — only proxy providers that speak the OpenAI API format. The router itself only exposes `/v1/chat/completions`, `/v1/responses`, and `/v1/models`.

## File Structure

```
lib/
  cli.ts             # Main entrypoint — routes commands
  config.ts          # Config loading
  proxy.ts           # HTTP/HTTPS request forwarding with streaming
  util.ts            # Shared types or functions
  server/
    index.ts         # creates HTTP server, mounts routes
    v1/              # OpenAI compatible API
    logs/            # Live logs stream
    status.ts        # Alive check
    config/          # Runtime config
closerouter.json     # Sample / default config
```

## Code Style

- TypeScript, ESM
- Prefer `async`/`await` over callbacks
- Functional and no classes
- Console logging is fine for observability

## Engineering

- Only comment when the code is abstract and needs explanation of implementation and decisions
- Create a skill at `.agents/skills` after interupted and instructed to push forward
