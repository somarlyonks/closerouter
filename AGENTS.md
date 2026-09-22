# AGENTS instructions

## Project Overview

`closerouter` is a lightweight, zero-dependency LLM proxy/router that exposes an OpenAI-compatible API and forwards requests to multiple backend providers based on the model name. It compiles to a native executable via `scriptc`.

## Key Constraints

- **Zero runtime dependencies** - use only Node.js built-in modules.
- **Compiled via `scriptc`** - the project is built with `scriptc`, which compiles TypeScript to a native binary. Keep code compatible with whatever Node.js API surface `scriptc` supports.
- **JSON config only** - no YAML, TOML, or other formats. Config file is `closerouter.json` by default, overridable via the `-c`/`--config <path>` CLI argument.
- **Streaming is critical** - `/v1/chat/completions` must support SSE streaming. Proxy responses should stream chunks back to the client without buffering the entire response.
- **OpenAI-format only** - only proxy providers that speak the OpenAI API format. The router itself only exposes `/v1/chat/completions`, `/v1/responses`, and `/v1/models`.

## Version Control

- **Never `git commit` without explicit approval from the user.** Leave changes in the working tree and report them; the user decides when (and whether) to commit.

## File Structure

```
[Project Root]/
├── lib/                        # Backend, compiled to a native binary by scriptc
│   ├── cli.ts                  # Entrypoint - parses CLI args and routes commands
│   ├── proxy.ts                # Provider request forwarding with SSE streaming
│   ├── router.ts               # Route composition: path/method predicates, dispatch, auth
│   ├── config/                 # JSON config loading and validation
│   │   ├── index.ts            # Load, validate config and inject defaults
│   │   ├── json-schema.ts      # JSON Schema subset validator + defaults injection
│   │   └── schema.json         # Config schema (embedded as schema.json.ts)
│   ├── db/                     # SQLite over scriptc FFI
│   │   ├── index.ts            # Connection bridge and query functions
│   │   ├── shim.c              # FFI source, compiled in place to shim.o
│   │   └── sqlite-demo.ts      # Standalone PoC harness for the FFI shim
│   └── server/                 # HTTP server and routes
│       ├── index.ts            # createServer, route mounting, shutdown
│       ├── status.ts           # GET /status - alive check, versions
│       ├── usage.ts            # GET /usage - usage stats and heatmap
│       ├── v1/                 # OpenAI-compatible API, proxied to providers
│       ├── logs/               # Request log history
│       └── config/             # Runtime config
├── assets/                     # Shared web assets and the HTML build
│   ├── build.ts                # Inlines /* @asset */ markers into lib HTML pages
│   └── *.css|svg|js|html       # Shared snippets
├── native/                     # FFI build
│   ├── ffi.json                # FFI shim list consumed by scriptc
│   └── build.ts                # Compiles the FFI shims in place
├── app/                        # macOS menu-bar client (SwiftUI, xcodegen project.yml)
├── test/                       # node:test suites, run on the .ts sources via test/loader.mjs
│   ├── *.test.ts               # Suites per module (router, proxy, db, routes, cli, ...)
│   ├── helpers.ts              # Mock req/res, mock backend, server + config helpers
│   ├── mock-server.js          # Standalone mock provider driven by mock-server.config.json
│   └── seed-usage.js           # Backfill synthetic usage rows through the mock server
├── build.ts                    # Build preparation: orchestrates assets/ + native/ builds
├── closerouter.json            # Sample / default config
└── closerouter.todo            # Development task tracker
```

## HTML Pages, Assets, and Build

Due to the limit of `scriptc` runtime file reading, HTML pages and JSON documents are authored as source files under `lib` (e.g. `lib/server/config/index.html`, `lib/config/schema.json`). They are **not** read at runtime - `assets/build.ts` converts each `.html` into a `.html.ts` module and each `.json` into a `.json.ts` module. Every generated module exports a fixed name (`html` for pages, `json` for documents). Import `.json.ts` modules with the explicit extension - scriptc resolves `'./schema.json'` to the raw JSON module, which it cannot compile statically.

- **Run the build:** `node build.ts` orchestrates both build steps - `assets/build.ts` (HTML + JSON; scans `lib/server` and `lib/config` for `*.html` and `*.json`, also accepts a file or dir arg passed through) and `native/build.ts` (compiles the FFI C shims listed in `native/ffi.json` in place). The generated `.html.ts` / `.json.ts` files are **gitignored build artifacts** - always regenerate after editing a source `.html`/`.json`, and don't edit them by hand.

### Assets

Shared assets live in the root `assets/` directory (`index.css`, `logo.svg`, `toast.js`, `key-dialog.html`, `footer.html`). Any ancestor `assets/` dir is discovered by `findAssetsDir` (walks up from the HTML file).

A file inside an assets dir is inlined into the HTML via a marker comment `/* @asset <name> */` (e.g. `/* @asset index.css */`, `/* @asset footer.html */`). The marker is replaced with the file's contents (trimmed) during the build step, so shared styles, scripts, and fragments live in one place with no runtime requests.

Rules for authored HTML:
- The rendered HTML must **not contain `\${`** - no template variables, since the content becomes a template literal.
- To add a shared fragment (like a footer) to multiple pages: create the fragment in `assets/`, reference it with `/* @asset <name> */` in each `.html`, and run `node assets/build.ts`.

### Page layout

`body` is a `display: flex; flex-direction: column`, and `main` has `flex: 1`, so a footer placed after `</main>` naturally pins to the bottom. Shared styles (including `.app-footer`) go in `assets/index.css`.

## Clean Code

1. Function and variable names explain **what** is done, split logic into concise functions with concrete names
2. Prevent comments, only comment when explanation of **why** or **how** necessary
3. Prevent side effects if possible
4. Prevent global mutable variables or objects
