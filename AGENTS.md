# AGENTS instructions

## Project Overview

`closerouter` is a lightweight, zero-dependency LLM proxy/router that exposes an OpenAI-compatible API and forwards requests to multiple backend providers based on the model name. It compiles to a native executable via `scriptc`.

## Key Constraints

- **Zero runtime dependencies** — use only Node.js built-in modules.
- **Compiled via `scriptc`** — the project is built with `scriptc`, which compiles TypeScript to a native binary. Keep code compatible with whatever Node.js API surface `scriptc` supports.
- **JSON config only** — no YAML, TOML, or other formats. Config file is `closerouter.json` by default, overridable via the `-c`/`--config <path>` CLI argument.
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

## HTML Pages, Assets, and Build

HTML pages are authored as `.html` source templates under `lib/server/` (e.g. `lib/server/config/index.html`, `lib/server/logs/index.html`). They are **not** served directly - `assets/build.ts` converts each into a `.html.ts` module (`index.html.ts`) that exports a template string (`indexHTML`), so `scriptc` can serve the HTML inline from the native binary with no runtime file read.

- **Run the build:** `node build.ts` orchestrates both build steps - `assets/build.ts` (HTML; scans `lib/server` for `*.html`, also accepts a file or dir arg passed through) and `native/build.ts` (compiles the FFI C shims listed in `native/ffi.json` in place). The generated `.html.ts` files are **gitignored build artifacts** - always regenerate after editing a source `.html`, and don't edit them by hand.

### Assets

Shared assets live in the root `assets/` directory (`index.css`, `logo.svg`, `toast.js`, `key-dialog.html`, `footer.html`). Any ancestor `assets/` dir is discovered by `findAssetsDir` (walks up from the HTML file).

A file inside an assets dir is inlined into the HTML via a marker comment `/* @asset <name> */` (e.g. `/* @asset index.css */`, `/* @asset footer.html */`). The marker is replaced with the file's contents (trimmed) during the build step, so shared styles, scripts, and fragments live in one place with no runtime requests.

Rules for authored HTML:
- The rendered HTML must **not contain `\${`** — no template variables, since the content becomes a template literal.
- To add a shared fragment (like a footer) to multiple pages: create the fragment in `assets/`, reference it with `/* @asset <name> */` in each `.html`, and run `node assets/build.ts`.

### Page layout

`body` is a `display: flex; flex-direction: column`, and `main` has `flex: 1`, so a footer placed after `</main>` naturally pins to the bottom. Shared styles (including `.app-footer`) go in `assets/index.css`.

## Code Style

- TypeScript, ESM
- Prefer `async`/`await` over callbacks
- Functional and no classes
- Console logging is fine for observability

## Engineering

- Only comment when the code is abstract and needs explanation of implementation and decisions
- Create a skill at `.agents/skills` after interupted and instructed to push forward
