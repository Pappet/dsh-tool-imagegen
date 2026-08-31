# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A DeepSeek Harness (DSH) plugin: text-to-image generation via OpenRouter's unified Image API
(`POST /api/v1/images` — **not** the OpenAI-compatible `/images/generations`). Registers one
tool, `generate_image`, that writes decoded images into the workspace and returns paths + cost.

## Commands

```sh
npm install
npm run build       # tsc, src/ -> lib/ — REQUIRED before tests: test/*.mjs imports from lib/, not src/
npm test            # node --test "test/*.test.mjs" (no network; fetch is faked)
npm run typecheck   # tsc --noEmit
```

Run a single test file/case: `node --test test/imagegen.test.mjs` (there's currently only one
test file); use `node --test-name-pattern <regex>` to filter individual `test(...)` cases inside it.

There is no lint script configured.

Live against a running harness: the plugin is installed into the profile as a link
(`dsh plugin add`), so `npm run build` plus a profile restart reloads it — the server reads
`dsh.client` once at boot, so a client-half change needs the restart too. Disposing the fiber
unregisters everything.

## Architecture

Nine source files plus one browser half (`lib/client.js`), each with a narrow, explicit contract (see the header comment of each — they state
their own boundaries better than prose reproduces them):

- **`src/index.ts`** — `apply()`/`applyWithDeps()`: registers the `generate_image` tool
  (params, output schema, `presentCall`/`presentResult` presenters) and owns the top-level
  execute flow: validate args → resolve model alias → capability-gate → call OpenRouter → write
  files → return the canonical result object. `applyWithDeps(ctx, config, { fetchImpl,
  workspaceRoot })` is the injectable entry point used by tests; `apply(ctx, config)` is what the
  bundle patch actually loads.
- **`src/config.ts`** — Schemastery schema (`Config`) and the derived `PluginConfig` /
  `ImagegenModelEntry` types. Models are configured as named **aliases**
  (`models.<alias>.{id, defaults}`); the alias is both the tool-call vocabulary and the
  allowlist — an id not registered under an alias is unreachable. The API key is never a config
  field: `apiKeyEnv` names a credential reference, resolved at call time through the dsh
  credentials seam first (see `src/key.ts`), then from `process.env[config.apiKeyEnv]`.
- **`src/openrouter.ts`** — bare HTTP client for `GET /images/models` and `POST /images`. No DSH
  imports, every dependency (fetch impl, signal, credentials) injected — testable standalone.
  `OpenRouterHttpError` carries `status` + response body text, since OpenRouter's body is where
  the repairable detail (which parameter, why) lives.
- **`src/capabilities.ts`** — `CapabilityCache` (TTL-cached `/images/models` listing, one shared
  fetch across aliases) and `buildParams()`, the parameter gate. This is the core design point of
  the plugin, so get it right when touching it:
  - Resolution order per parameter: **call argument → alias `defaults` → omitted**.
  - Two deliberately different error classes: a call-named parameter the model doesn't support is
    a **hard error**; an unsupported **config default** is silently dropped (surfaced later via
    `droppedDefaults` in the result) — the idea being defaults are wishes, not promises, but an
    explicit call argument is the model asking for something specific.
  - A value that's the wrong *type/range* for a supported parameter is always an error, regardless
    of origin — just attributed differently (`Invalid "<key>"...` for call args vs
    `Configuration error: imagegen.models.<alias>.defaults...` for config).
  - `descriptorKnown: false` (listing never loaded) means capabilities are unknown, not empty —
    the gate forwards params ungated rather than dropping/rejecting them.
  - `gateReferences()` is separate on purpose: `input_references`' descriptor is a `range` over
    the COUNT, so `buildParams`' generic value check would test the array against an integer
    range and reject every call. Same two error classes; files are read only after it passes.
- **`src/write.ts`** — decode base64 → write to disk, filename derivation, collision-safe
  naming (`resolveUniquePath`/`withIndex`). Node-only but harness-free (no DSH imports).
  `withMediaExtension()` makes an `output_path`'s extension agree with the returned encoding
  (the caller names the file, the model decides the encoding); an unknown media type leaves
  the caller's path alone rather than guessing.
- **`src/references.ts`** — image-to-image inputs: `http(s)` URLs pass through, paths are read,
  capped (`maxReferenceBytes` / `maxReferenceTotalBytes`), identified by MAGIC BYTES and inlined
  as base64 data URLs. Node-only, harness-free. The wire shape is a content block,
  `{ type: 'image_url', image_url: { url } }` — not a bare string.
- **`src/settings.ts`** — the `dsh-tool-imagegen` settings namespace behind the configuration
  card: schema, the `ImagegenSettings` shape, and `settingsFromConfig()` (the composition `base`).
  `models` is a LIST here while the config keeps a dict, and that is load-bearing: dsh-settings'
  `mergeLayers` merges plain objects RECURSIVELY and replaces arrays wholesale, so a dict in the
  user layer could never delete an alias the base declares — the row would re-inherit from
  `cordis.yml` on the next read. `validateSettings` is the cross-field check the schema cannot
  express (duplicate/empty alias, missing slug); it refuses the write rather than storing
  something the tool cannot act on.
  Layering is `schema defaults → base (cordis config) → user layer`, so a card edit is an override
  on the config and clearing a field falls back to the configured value. Deliberately NOT editable:
  `apiKeyEnv`, `baseURL`, `capabilityTtlMs` — the capability cache is built from the last two once
  at apply time, so a live edit could not take effect.
- **`src/chat.ts`** — the chat display path (config `showInChat`, default true): saves attachable
  images (png/jpeg/webp/gif — SVG is skipped) into the attachment store (opportunistic via
  `ctx.get('attachments')`, injectable as `deps.attachments`) and builds the plugin-sourced user
  message (`createUserMessage`, `source.kind: 'plugin'`, `form: 'notice'` + `summary` from
  `chatSummary()` so the collapsed context row reads "Image created: …") that `execute` hands to
  `exec.deferContext`. The model sees it (text-only adapters substitute a placeholder); in the web
  UI it lands as a context-injection ROW, not the history gallery — `source.kind !== 'user'` routes
  it there, and that row renders text blocks only, so the image itself is shown by the client half's
  tool card instead. All contained: store failures never fail the generation.

`execute()` reads the tunables from the LIVE settings (`live`, updated by the namespace's
`watch`), not from the frozen `config`: aliases, `defaultModel`, `outputDir`, `showInChat`,
`maxImagesPerCall` and the reference caps change without a restart. It snapshots them once per
call, so a commit landing mid-call cannot change the rules that call is judged by. One deliberate
staleness: the `n` parameter DESCRIPTION quotes the configured cap at registration time, while the
check enforces the live one.

Call flow in `execute()` (index.ts) worth knowing before changing it: the capability record is
fetched once, params gated, and the request sent; on an HTTP 400 **and** a cached record having
been present, the cache is invalidated once and the whole gate+call is retried exactly once
(self-healing against a stale capability listing without paying a refetch on every call).

### Testing approach

`test/imagegen.test.mjs` is the only test file: `node:test`, no network, `fetch` faked with
minimal `{ ok, status, text, json }` stubs, real files written to a `mkdtemp` temp dir. It imports
compiled output from `../lib/*.js`, so **rebuild before testing** whenever `src/` changes.
`applyWithDeps` is exercised directly with a stub `Context`/`exec` rather than a real DSH harness.

### Client half (lib/client.js)

`lib/client.js` is the browser bundle (manifest under `dsh.client` in package.json — NOT
`dsh.bundle.client`, which `dsh-client-modules` never reads; served at
`/plugins/dsh-tool-imagegen/client.js`). It is hand-written against the
`window.__ModuleLoader__.load({ id, factory })` contract — plain `React.createElement`, no JSX,
no build step; `tsc` never touches it. It registers the keyed `tool.call.toolview` view for
`generate_image` (replacing the generic card), reads the settled node's `meta.attachments`, and
loads bytes via `ctx.get('sessions').binding(current).session.readAttachment(attachmentId)`
(current session = `sessions.list.getSnapshot().current`). Everything degrades to the path list.

All user-facing copy is English, with a Simplified Chinese dictionary beside it: the harness UI
offers 中文 and English only, so a third language would be the odd one out. The browser half
registers both through `ctx.locale.register(NS, { zh, en })` and keys its slots with `locale: NS`,
so a component reads `props.t`; without the locale service every string still resolves through the
English fallback. The SERVER-side copy (the `presentCall`/`presentResult` titles and
`chatSummary`) has no locale seam and is English outright.

It also registers the configuration card in `settings.plugin.item`, keyed on the settings
namespace, mounted in a child fiber that waits for `settingsScope` so a deployment without the
settings surface still gets the tool card. The section renders its cards into a `<ul>`, so the
card's root is an `<li>` wearing the same shell as the built-in ones (collapsed by default,
chevron, "Ungespeichert" pill, discard/save footer). The fields inside follow
`fields.module.css`: a `.field` column per tunable (`padding: 12px 0`, divider between fields),
label 13px/500 sharing the head row with the overridden badge and a plain-text reset, a 34px
input, and a 12px hint that turns into the error line. Those styles are RESTATED, not reused:
the class names in both files are module-hashed and the chevron is a primitives value import,
all closed to a third-party bundle — keep the values in step with those two files. One thing the
standard has no precedent for is a boolean, so `showInChat` is a checkbox in the control slot. The browser scope is `getSnapshot`/`subscribe`/`set`/
`unset`; `set(field, value)` takes a JSON-shaped value, which is what lets the whole `models`
dict be written as ONE field. "Overridden" comes from a key's PRESENCE in `snapshot.user`, never
from comparing values.

### Policy boundary

No permission/allow-deny/cost-cap logic lives in this plugin. `maxImagesPerCall` is a sanity guard
against a hallucinated `n`, not a budget control — those concerns belong in a
`tools/pre-execute` listener, `ctx.tools.guard()`, or a separate hook plugin at the harness level.

### Configuration shape

The bundle patch (`cordis.patch.yml`) inserts one row with `config` fields defined by
`src/config.ts`'s schema — see README.md for the full example (aliases, defaults, TTLs). Config
rows are replaced wholesale on patch, never deep-merged, so an overlay's `config` must be complete.
