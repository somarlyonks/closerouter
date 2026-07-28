# AGENTS instructions

## Project Overview

`closerouter` is a lightweight, zero-dependency LLM proxy/router that exposes an OpenAI-compatible API and forwards requests to multiple backend providers based on the model name. It compiles to a native executable via `scriptc`.

## Key Constraints

- **Zero runtime dependencies** — use only Node.js built-in modules (`http`, `https`, `fs`, `path`, `url`, `stream`, `crypto`).
- **Compiled via `scriptc`** — the project is built with `scriptc`, which compiles TypeScript to a native binary. Keep code compatible with whatever Node.js API surface `scriptc` supports.
- **JSON config only** — no YAML, TOML, or other formats. Config file is `closerouter.json` by default.
- **Streaming is critical** — `/v1/chat/completions` must support SSE streaming. Proxy responses should stream chunks back to the client without buffering the entire response.
- **OpenAI-format only** — only proxy providers that speak the OpenAI API format. The router itself only exposes `/v1/chat/completions` and `/v1/models`.

## File Structure

```
lib/
  server.ts          # Main entrypoint — creates HTTP server, mounts routes
  config.ts          # Config loading & env interpolation
  router.ts          # Model → provider resolution
  proxy.ts           # HTTP/HTTPS request forwarding with streaming
  routes/
    chat.ts          # POST /v1/chat/completions
    models.ts        # GET /v1/models
closerouter.json     # Sample / default config
plan.md              # Design plan
```

## Code Style

- TypeScript, ESM (`"type": "module"`)
- Prefer `async`/`await` over callbacks
- Minimal abstractions — keep it simple
- No classes unless they genuinely model stateful objects
- Console logging is fine for observability (no logging library)
