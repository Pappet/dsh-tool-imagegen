# dsh-tool-imagegen

Text-to-image generation for DeepSeek Harness via OpenRouter's unified Image
API (`POST /api/v1/images` — not the OpenAI-compatible `/images/generations`).
The tool generates an image from a prompt, writes it into the workspace, and
returns one canonical JSON value with file paths and cost.

Multiple models are configured as **aliases**; generation parameters are
**gated against the model's capability record** (`GET /api/v1/images/models`)
instead of being hard-wired.

## Tool: `generate_image`

| Parameter | Type | Notes |
|---|---|---|
| `prompt` | string, required | What to depict. |
| `model` | string | Configured alias; defaults to `defaultModel`. |
| `resolution` | string | e.g. `1K` \| `2K` \| `4K` — model dependent. |
| `aspect_ratio` | string | e.g. `1:1`, `16:9` — model dependent. |
| `n` | integer | How many images (default 1, at most `maxImagesPerCall`). |
| `seed` | integer | When the model supports it. |
| `output_format` | string | e.g. `png` \| `jpeg` — most models decide the encoding themselves and list no descriptor. |
| `input_references` | string[] | Reference images to edit or vary: workspace paths or `http(s)` URLs. |
| `output_path` | string | Target path for the first image, absolute or workspace-relative. The extension follows the returned encoding. |

The canonical return value carries `model`, `alias`, `images[]`
(`path`, `mediaType`, `bytes`), `costUsd` (exact, from the API's `usage.cost`),
`applied` (the parameters actually sent) and `droppedDefaults`. `applied` lets
the model see what was really used — e.g. after the gate dropped a config
default — and adjust the next attempt.

## Image-to-image (`input_references`)

Each value is either an `http(s)` URL, passed through untouched, or a path
(absolute or workspace-relative, resolved against the session cwd like
`output_path`). A path is read, capped, identified by its **magic bytes** and
inlined as a base64 data URL — the file NAME is never consulted, because a
name can lie about the encoding and a mislabelled data URL fails at the
provider with an error that points nowhere near the cause.

`applied.input_references` echoes what the call named, never the payload.

The capability descriptor is a range over the **count**, not over a value:

```json
"input_references": { "type": "range", "min": 0, "max": 14 }
```

so it gets its own gate with the same two error classes as everything else —
a count the model cannot honor is an error when the call named the list, a
dropped default when the config did. Files are read only after that gate
passes: a call against a model without the capability never touches the disk.

Caps are `maxReferenceBytes` (per file) and `maxReferenceTotalBytes` (all
together), both measured on the bytes on disk; base64 adds roughly a third on
the wire.

> Support varies by model. Seedream 4.5 / 5.0 accept up to 14 references but
> list no `output_format`; the GPT-Image family accepts 16 and adds `quality`,
> `background` and `output_compression`; the Recraft vector models emit `svg`
> only and some **require** at least one reference (`min: 1`).

## Capability gate

OpenRouter's `supported_parameters` uses typed descriptors (`enum`, `range`,
`boolean`); an absent key means the parameter is unsupported. Resolution order
per parameter: **call argument → alias `defaults` → omitted**. Two error
classes, deliberately different:

| Origin | Parameter unsupported | Value outside the descriptor |
|---|---|---|
| Named in the call | **Error** naming parameter and model | **Error** listing allowed values |
| Config `defaults` | Silently dropped (reported in `droppedDefaults`) | **Error** attributed to the config |

The cache holds the `/images/models` listing for `capabilityTtlMs` (default
24 h) and is invalidated once on a 400, then re-gated and retried once — so a
stale record self-heals without an extra round-trip per image.

## Configuration

```yaml
- insert:
    - id: imagegen
      name: 'dsh-tool-imagegen'
      config:
        apiKeyEnv: OPENROUTER_API_KEY      # credential ref / env var NAME (the secret itself is never config)
        baseURL: https://openrouter.ai/api/v1
        outputDir: .dsh/images             # workspace-relative
        defaultModel: seedream
        capabilityTtlMs: 86400000
        maxImagesPerCall: 4                # guard against hallucinated n
        maxReferenceBytes: 8388608         # per reference image (8 MiB on disk)
        maxReferenceTotalBytes: 33554432   # all references of one call (32 MiB)
        models:
          seedream:
            id: bytedance-seed/seedream-4.5
            defaults: { resolution: "2K", aspect_ratio: "16:9" }
          seedream-pro:
            id: bytedance-seed/seedream-5-0-pro
          seedream-lite:
            id: bytedance-seed/seedream-5-0-lite
```

> Slugs verified against `GET /api/v1/images/models`: the Seedream 5.0 models
> are `seedream-5-0-pro` / `seedream-5-0-lite` (dashes, not dots), and e.g.
> 5.0-pro only accepts `n ≤ 1` and resolutions `1K|2K`. The gate catches such
> mismatches — an alias whose slug is wrong surfaces as an HTTP error carrying
> the API's body text.

> **API key**: `apiKeyEnv` names a dsh credential reference, resolved through
> the credentials seam first (`$DSH_HOME/.credentials.yaml` under
> `refs.<name>`, plus the provider's env layers), then from the same-named
> process environment variable — the same convention as `llm-pi-ai` and
> `dsh-github`. The value never reaches config, logs, or model-visible text.

## Presentation

- `presentCall`: generic card, title "Bild generieren", `kind: 'other'`
  (the `ToolCallKind` vocabulary has no image kind), prompt excerpt.
- `presentResult`: generic completed card with the persisted paths as content.
  Paths travel through `output.presentationMeta` so the card survives
  session-log replay; presenters stay pure functions of `args` (plus result).
  Note: `GenericResultView` has no `locations` field (that exists only on the
  pending-call view), so the result card carries the paths as content blocks.

## Chat display

With `showInChat` (default `true`), every generated image is additionally
committed to the durable attachment store (`ctx.attachments.saveImage`,
opportunistic — a deployment without the service only loses the preview), and
`execute` defers one plugin-sourced user message
(`createUserMessage`, `source: { kind: 'plugin' }`) via `exec.deferContext`.
The message also reaches the model context — useful for iteration; text-only
adapters substitute their text placeholder. The canonical value
carries the durable `attachments` refs, and non-attachable media (SVG) are
silently skipped. Every step is contained: an attachment-store outage never
fails an otherwise successful generation.

### Inline tool card (client half)

`lib/client.js` is the browser half (declared via the `dsh.client`
manifest, served at `/plugins/dsh-tool-imagegen/client.js`). It registers the
keyed `tool.call.toolview` view for `generate_image`, replacing the generic
text card with an inline image card: the settled result renders the image(s)
directly, loaded through `session.readAttachment` from the meta's durable
attachment refs; a click opens the file through the Host opener. Pending
calls show the prompt excerpt; any unavailability (no meta, no attachment
service, load failure) degrades to the plain path list. The card is
hand-written against the `window.__ModuleLoader__` contract — no build step;
`tsc` does not touch it.

## Policy

No permission logic in the tool: allow/deny/ask belongs in a
`tools/pre-execute` listener, a final deny in `ctx.tools.guard()`, and a cost
cap in a separate hook plugin. `maxImagesPerCall` is only a sanity guard
against hallucinated `n` values, not a budget.

## Development

```sh
npm install
npm run build        # tsc → lib/
npm test             # node:test, no network, mocked fetch
npm run typecheck    # tsc --noEmit
```

For a live install, link the checkout into a dsh profile (`dsh plugin add`); after
`npm run build`, a profile restart reloads both halves.

`applyWithDeps(ctx, config, { fetchImpl, workspaceRoot })` is the injectable
entry point for tests; `apply(ctx, config)` is the production plugin.

## Layout

```
src/
  index.ts         # apply(), tool registration, presenters
  config.ts        # Schemastery schema
  openrouter.ts    # HTTP client: /images, /images/models (no DSH imports)
  capabilities.ts  # capability cache + parameter gate
  write.ts         # base64 → file, naming, collision handling (no DSH imports)
```
