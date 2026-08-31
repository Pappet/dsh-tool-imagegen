# dsh-tool-imagegen

[![CI](https://github.com/Pappet/dsh-tool-imagegen/actions/workflows/ci.yml/badge.svg)](https://github.com/Pappet/dsh-tool-imagegen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen.svg)](package.json)

Image generation for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
through OpenRouter's unified Image API (`POST /api/v1/images` — **not** the
OpenAI-compatible `/images/generations`).

One tool, `generate_image`: it takes a prompt, optionally a few reference
images, writes the result into the workspace and returns the paths and the
exact cost. Generated images appear inline in the chat.

- **Models are aliases.** The alias is the vocabulary the model uses *and* the
  allowlist — a model without an alias cannot be reached.
- **Parameters are gated against the model's capability record**
  (`GET /api/v1/images/models`), not hard-wired. A call asking for something a
  model cannot do fails with a message naming the parameter and the model.
- **Image-to-image** via `input_references`: workspace paths or URLs, up to
  what the model accepts (14 for Seedream, 16 for the GPT-Image family).
- **Editable at runtime.** A card in the *Plugins* settings section edits the
  aliases and tunables; changes apply live, no restart.

---

## Install

```sh
dsh plugin --profile web add dsh-tool-imagegen
```

That installs the package into the profile and lists it under
`dsh.profile.bundles`; the shipped bundle patch inserts the plugin row. Then
give it a key. `apiKeyEnv` names a **credential reference**, never the
secret itself:

```sh
export OPENROUTER_API_KEY=sk-or-...
```

or, preferred, put it in `$DSH_HOME/.credentials.yaml` under
`refs.OPENROUTER_API_KEY`. The credentials seam is tried first, the
same-named environment variable second — the same convention as `llm-pi-ai`
and `dsh-github`. The value never reaches config, logs, or model-visible text.

The plugin ships no model aliases; see [Configuration](#configuration).

---

## Tool: `generate_image`

| Parameter | Type | Notes |
|---|---|---|
| `prompt` | string, **required** | What to depict. |
| `model` | string | Configured alias; defaults to `defaultModel`. |
| `resolution` | string | e.g. `1K` \| `2K` \| `4K` — model dependent. |
| `aspect_ratio` | string | e.g. `1:1`, `16:9` — model dependent. |
| `n` | integer | How many images (default 1, at most `maxImagesPerCall`). |
| `seed` | integer | When the model supports it. |
| `output_format` | string | e.g. `png` \| `jpeg` — most models decide the encoding themselves and list no descriptor. |
| `input_references` | string[] | Reference images to edit or vary: workspace paths or `http(s)` URLs. |
| `output_path` | string | Target for the first image, absolute or workspace-relative. The extension follows the returned encoding. |

The return value carries `model`, `alias`, `images[]` (`path`, `mediaType`,
`bytes`), `costUsd` (exact, from the API's `usage.cost`), `applied` — the
parameters actually sent — and `droppedDefaults`. `applied` is what lets the
model see what was really used, e.g. after the gate dropped a config default,
and adjust the next attempt.

> `output_path` names the file, but the model decides the encoding. A call
> asking for `bild.png` from a model that emits JPEG gets `bild.jpg`: a file
> must not lie about its contents.

---

## Capability gate

`supported_parameters` uses typed descriptors (`enum`, `range`, `boolean`); an
absent key means the parameter is unsupported. Resolution order per parameter:
**call argument → alias `defaults` → omitted**. Two error classes, deliberately
different:

| Origin | Parameter unsupported | Value outside the descriptor |
|---|---|---|
| Named in the call | **Error** naming parameter and model | **Error** listing allowed values |
| Config `defaults` | Silently dropped (reported in `droppedDefaults`) | **Error** attributed to the config |

Defaults are wishes, not promises. An explicit call argument is the model
asking for something specific, so it is never silently ignored.

The cache holds the `/images/models` listing for `capabilityTtlMs` (default
24 h) and is invalidated once on a 400, then re-gated and retried once — so a
stale record self-heals without an extra round-trip per image.

> The record is not the last word: Seedream 4.5 lists `1K` as a valid
> `resolution` but rejects it at call time ("requires at least 3,686,400 output
> pixels"). The gate forwards what the record allows; the API's own error text
> is carried through verbatim.

---

## Image-to-image

```jsonc
{
  "prompt": "Turn this into a soft watercolor painting, same composition.",
  "input_references": ["bilder/vorlage.png", "https://example.com/style.jpg"]
}
```

Each value is either an `http(s)` URL, passed through untouched, or a path
(absolute or workspace-relative, resolved against the session cwd like
`output_path`). A path is read, capped, identified by its **magic bytes** and
inlined as a base64 data URL. The file *name* is never consulted: a name can
lie about the encoding — this plugin used to write JPEG payloads under a `.png`
name — and a mislabelled data URL fails at the provider with an error that
points nowhere near the cause.

`applied.input_references` echoes what the call named, never the payload.

The capability descriptor is a range over the **count**, not over a value:

```json
"input_references": { "type": "range", "min": 0, "max": 14 }
```

so it gets its own gate, with the same two error classes as everything else.
Files are read only after that gate passes: a call against a model without the
capability never touches the disk.

Caps are `maxReferenceBytes` (per file) and `maxReferenceTotalBytes` (all
together), both measured on the bytes on disk; base64 adds roughly a third on
the wire.

> Support varies by model. Seedream 4.5 / 5.0 accept up to 14 references but
> list no `output_format`; the GPT-Image family accepts 16 and adds `quality`,
> `background` and `output_compression`; the Recraft vector models emit `svg`
> only and some **require** at least one reference (`min: 1`).

---

## Configuration

No aliases ship by default, so the plugin does nothing until you name at least
one. Put a config override into your profile's `cordis.patch.yml`:

```yaml
- id: imagegen
  config:
    apiKeyEnv: OPENROUTER_API_KEY      # credential ref / env var NAME, never the secret
    baseURL: https://openrouter.ai/api/v1
    outputDir: .dsh/images             # workspace-relative
    defaultModel: seedream
    capabilityTtlMs: 86400000          # 24 h
    maxImagesPerCall: 4                # guard against a hallucinated n
    maxReferenceBytes: 8388608         # per reference image (8 MiB on disk)
    maxReferenceTotalBytes: 33554432   # all references of one call (32 MiB)
    showInChat: true
    models:
      seedream:
        id: bytedance-seed/seedream-4.5
        defaults: { resolution: "2K", aspect_ratio: "16:9" }
      seedream-pro:
        id: bytedance-seed/seedream-5-0-pro
      seedream-lite:
        id: bytedance-seed/seedream-5-0-lite
```

> A config override **replaces the row's config wholesale** — it is never
> deep-merged — so every key that matters has to be repeated. Keys you omit
> fall back to their schema defaults, not to the bundle patch's values.

> Slugs verified against `GET /api/v1/images/models`: the Seedream 5.0 models
> are `seedream-5-0-pro` / `seedream-5-0-lite` (dashes, not dots), and 5.0-pro
> accepts only `n ≤ 1` and resolutions `1K|2K`. An alias whose slug is wrong
> surfaces as an HTTP error carrying the API's body text.

### Settings card

The plugin registers the settings namespace `dsh-tool-imagegen`, and the
browser half contributes a card to the *Plugins* settings section: the alias
table (alias, slug, defaults as JSON) plus the scalar tunables. The two byte
caps are entered in MiB; the document keeps bytes.

Config and card are layered, not alternatives:

```
schema defaults  →  base (this plugin's cordis config)  →  user layer (the card)
```

so `cordis.yml` stays the deployment's stated intent, a card edit is an
override on top of it, and *Reset* falls back to exactly the configured value
rather than to a schema default nobody chose. Changes apply live.

The alias registry is a **list** in the settings layer even though the config
uses a dict. That is not cosmetic: the layers merge plain objects *recursively*
and replace arrays wholesale, so a dict in the user layer could never delete an
alias the config declares — a removed row would silently re-inherit. As a list,
what the card writes is the whole registry.

`apiKeyEnv`, `baseURL` and `capabilityTtlMs` stay config-only: they are
deployment decisions, and the capability cache is built from the latter two
once at apply time, so a live edit could not take effect.

Without a settings service (a headless deployment) the tool runs on the
configured values — unconfigurable, but working.

---

## In the chat

With `showInChat` (default `true`), every generated image is committed to the
durable attachment store, and `execute` defers one plugin-sourced message so
the **model** sees the picture too — useful for iteration; text-only adapters
substitute their text placeholder.

What the **reader** sees is the tool card: `lib/client.js` registers the keyed
`tool.call.toolview` for `generate_image` and renders the image inline, loaded
through `session.readAttachment` from the durable refs in the result meta. A
click opens the file through the Host opener.

The deferred message lands as a context-injection row rather than in the
history gallery — a message whose source is not `user` is classified as
injected context — so it declares the `notice` form and a one-line summary,
and the collapsed row reads `Image created: /path/to/file.jpg`.

Every step is contained: an attachment-store outage never fails an otherwise
successful generation, and non-attachable media (SVG) are skipped.

All user-facing copy is English, with a Simplified Chinese dictionary beside
it, registered through the harness locale service — the UI offers 中文 and
English, so the cards follow whichever is selected.

---

## Policy boundary

No permission logic lives in this plugin. Allow/deny/ask belongs in a
`tools/pre-execute` listener, a final deny in `ctx.tools.guard()`, and a cost
cap in a separate hook plugin. `maxImagesPerCall` is a sanity guard against a
hallucinated `n`, not a budget control.

---

## Development

```sh
npm install          # `prepare` builds; tests import the compiled output
npm run build        # tsc → lib/
npm test             # node:test, offline: the host half + the browser half in jsdom
npm run typecheck    # tsc --noEmit
```

Tests never touch the network: `fetch` is faked, files land in a temp
directory, and the browser half is mounted in jsdom and clicked — expanded,
typed into, saved — because nothing else looks at that file (`tsc` ignores it
and `node --check` only proves it parses).

The `@deepseek-ai/*` packages are **peer** dependencies: the harness provides
them at runtime, and a second copy of an identity-sensitive contract would
shadow the host's.

For a live install, link the checkout into a dsh profile (`dsh plugin add`);
after `npm run build`, a profile restart reloads both halves.

`applyWithDeps(ctx, config, { fetchImpl, workspaceRoot, attachments, settings })`
is the injectable entry point used by the tests; `apply(ctx, config)` is what
the harness loads.

### Layout

```
src/
  index.ts         # apply(), tool registration, presenters, the execute flow
  config.ts        # Schemastery schema for the cordis entry config
  settings.ts      # the settings namespace behind the configuration card
  capabilities.ts  # capability cache + the parameter gate
  openrouter.ts    # HTTP client: /images, /images/models   (no DSH imports)
  references.ts    # reference images → data URLs           (no DSH imports)
  write.ts         # base64 → file, naming, collisions      (no DSH imports)
  chat.ts          # attachment store + the deferred message
  key.ts           # credential resolution
lib/client.js      # browser half: tool card + settings card (hand-written, no build step)
test/
  imagegen.test.mjs  # host half
  client.test.mjs    # browser half, in jsdom
```

---

## License

MIT — see [LICENSE](LICENSE).
