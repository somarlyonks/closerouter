# pi-closerouter

A [pi](https://github.com/earendil-works/pi) package that adds a local
[closerouter](https://github.com/somarlyonks/closerouter) gateway to pi as a
provider, so every model closerouter routes shows up in `/model`.

Streaming is delegated to pi's built-in OpenAI Chat Completions implementation,
and the model list is discovered from closerouter's `GET /v1/models`, so adding a
provider or model to closerouter makes it appear in pi on the next refresh.

## Install

```bash
pi install ./plugin/pi-closerouter
```

Try it for one run without changing settings:

```bash
pi -e ./plugin/pi-closerouter
```

Then pick a model with `/model` — closerouter models appear as
`closerouter/<provider>/<model>`, e.g. `closerouter/deepseek/deepseek-v4-flash`.

## Configure

The gateway is resolved in this order:

1. `CLOSEROUTER_URL` and `CLOSEROUTER_KEY` environment variables.
2. The `closerouter` field of pi's settings (`~/.pi/agent/settings.json`):

   ```json
   {
       "closerouter": {
           "baseUrl": "http://127.0.0.1:6712",
           "apiKey": "sk-cr-...",
           "models": [
               "deepseek/deepseek-flash",
               { "id": "deepseek/deepseek-v4-pro", "reasoning": true, "contextWindow": 128000 },
               { "id": "ark/deepseek-v4.1-flash", "$alias": "deepseek/deepseek-flash" }
           ]
       }
   }
   ```

   `models` lists the closerouter models pi exposes: a bare id string to include as
   reported, or an object whose `id` plus fields override what closerouter and pi's
   catalog report (any model field — reasoning, context window, cost, thinking
   levels, prompt cache, sampling params, compat, …). An entry whose provider pi
   does not know can name a catalog model to inherit through `$alias`, e.g.
   `{ "id": "ark/deepseek-v4.1-flash", "$alias": "deepseek/deepseek-flash" }`, so
   the wire id stays closerouter's while the specs come from pi's `deepseek`
   catalog entry; explicit fields still win over the alias. A configured id is
   authoritative: it is exposed even when the gateway's `/v1/models` does not
   report it, taking its specs from `$alias`/pi's catalog and then defaults. Leave
   `models` out (or empty) to expose every model the gateway reports instead. `api`
   is taken from pi's catalog for models it knows (`openai-completions` or
   `openai-responses`) and defaults to `openai-completions`; a `models` entry may
   set it. `baseUrl` and `type` always stay closerouter's. `PI_CODING_AGENT_DIR`
   moves where the settings file is read from. Configured models are registered at
   startup, so resuming a session that points at a closerouter model restores even
   before the gateway is queried.

3. The port and key of a `closerouter.json` found at `CLOSEROUTER_CONFIG`, the
   working directory, `~/Library/Application Support/CloseRouter/`, or
   `~/.config/closerouter/`.
4. The defaults `http://127.0.0.1:6712` and the built-in key.

Model metadata can also be adjusted the standard pi way through
`modelOverrides` in pi's `models.json`.

## Model specs

closerouter's `/v1/models` reports little beyond ids, so each model's specs are
taken from pi's bundled catalog when the id's `<provider>/<model>` matches a
provider pi knows (e.g. `deepseek/deepseek-flash`,
`openrouter/anthropic/claude-sonnet-4.5`): name, reasoning, thinking levels, input
modalities, cost, context window, and output limit. Precedence is a field in a
`closerouter.models` entry > an entry's `$alias` > pi's catalog > closerouter's own
`/v1/models` fields > defaults. `baseUrl` and `type` always stay closerouter's; `api` comes from pi's
catalog (or a `models` entry), limited to `openai-completions`/`openai-responses`
and defaulting to `openai-completions`. When a catalog entry uses one of those two
OpenAI APIs its `compat` and `thinkingLevelMap` are copied too, since the request
reaches the same upstream through closerouter; an entry for any other wire format
(Anthropic, Google, Bedrock, …) contributes only wire-agnostic metadata and is
ignored for `api`, `compat`, and `thinkingLevelMap`, so its protocol cannot leak
past the OpenAI edge. A `models` entry may still set any model field, and wins over
all of the above. `models` also selects which ids pi exposes.
