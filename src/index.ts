/**
 * dsh-tool-imagegen: text-to-image generation for DeepSeek Harness.
 *
 * Generates images through OpenRouter's unified Image API (POST /api/v1/images),
 * writes them into the workspace, and returns one canonical JSON value with
 * paths and cost. Multiple models are configured as aliases; parameters are
 * gated against the model's capability record from GET /api/v1/images/models
 * instead of being hard-wired.
 *
 * The tool knows no permission logic: allow/deny/ask belongs in a
 * `tools/pre-execute` listener (and `ctx.tools.guard()` for a final deny), a
 * cost cap belongs in a separate hook plugin.
 *
 * Every registration is an effect — disposing the plugin fiber reverses all of
 * them, including the tool itself.
 * @module dsh-tool-imagegen
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { CapabilityCache, buildParams, gateReferences } from './capabilities.js';
import { buildChatMessage, isAttachableMediaType, toSaveInput, toValueRef, type AttachmentSeam, type ChatImage } from './chat.js';
import { Config, type ImagegenModelEntry, type PluginConfig } from './config.js';
import { resolveApiKey } from './key.js';
import {
    IMAGEGEN_SETTINGS_NAMESPACE,
    ImagegenSettingsSchema,
    isUsableSettings,
    settingsFromConfig,
    type ImagegenSettings,
    type SettingsSeam,
} from './settings.js';
import { OpenRouterHttpError, generateImage } from './openrouter.js';
import { readReferences, toWireReference, type ImageReference } from './references.js';
import { sanitizeName, timestampForName, writeImages } from './write.js';

export const name = 'dsh-tool-imagegen';
/** Services this plugin requires; all exist in any profile built on dsh-base. */
export const inject = ['tools', 'credentials'];
export { Config };
export type { PluginConfig };

const IMAGEGEN_TIMEOUT_MS = 300_000;
const PROMPT_CARD_EXCERPT = 200;

/** Resolve the alias against the live allowlist. */
function resolveModel(settings: ImagegenSettings, alias: string): ImagegenModelEntry {
    const entry = settings.models?.[alias];
    if (!entry?.id) {
        const known = Object.keys(settings.models ?? {});
        throw new Error(
            `Unknown model alias "${alias}". Configured aliases: ${known.length ? known.join(', ') : '(none — configure imagegen.models)'}.`,
        );
    }
    return entry;
}

/** Validate the reference list shape before anything touches the disk. */
function asReferenceList(value: unknown, origin: 'call' | 'default', alias: string): string[] {
    const where = origin === 'call' ? '"input_references"' : `imagegen.models.${alias}.defaults.input_references`;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
        throw new Error(`Invalid ${where}: expected an array of non-empty paths or http(s) URLs, got ${JSON.stringify(value)}.`);
    }
    return value.map((v) => (v as string).trim());
}

/** Environment-dependent runners, injectable for tests. */
export interface PluginDeps {
    /** fetch implementation for both OpenRouter endpoints; defaults to global fetch. */
    fetchImpl?: typeof fetch;
    /** Workspace root for resolving relative output paths; defaults to process.cwd() at call time. */
    workspaceRoot?: string;
    /** Attachment store for the chat image display; defaults to ctx.get('attachments'). */
    attachments?: AttachmentSeam;
    /** Settings service backing the configuration card; defaults to ctx.inject(['settings']). */
    settings?: SettingsSeam;
}

/**
 * Apply the plugin with an injectable fetch runner.
 * @param ctx - plugin context; the injected services are ready at this point.
 * @param config - validated Schemastery configuration (defaults applied).
 * @param deps - optional fetch runner.
 */
export function applyWithDeps(ctx: Context, config: PluginConfig, deps: PluginDeps = {}): void {
    const capabilities = new CapabilityCache({
        baseURL: config.baseURL,
        ttlMs: config.capabilityTtlMs,
        fetchImpl: deps.fetchImpl,
    });
    const credentials = ctx.credentials;
    // Opportunistic, not injected: a deployment without the attachment store
    // (e.g. headless) keeps the tool working — only the chat preview is lost.
    const attachments: AttachmentSeam | undefined = deps.attachments
        ?? (typeof ctx.get === 'function' ? (ctx.get('attachments') as AttachmentSeam | undefined) : undefined);

    // The tunables the configuration card owns, resolved fresh per call. The
    // entry config is the composition BASE the user layer resolves over, and
    // the fallback wherever no settings service exists (headless): the tool
    // then runs on the configured values, unconfigurable but working.
    let live: ImagegenSettings = settingsFromConfig(config);
    const bindSettings = (settings: SettingsSeam) => {
        const scope = settings.register(IMAGEGEN_SETTINGS_NAMESPACE, ImagegenSettingsSchema, {
            base: settingsFromConfig(config),
            applies: 'live',
        });
        const initial = scope.get();
        if (isUsableSettings(initial)) live = initial;
        // A document hand-edited into a shape the tool cannot act on keeps the
        // last good value rather than stranding the tool, as the settings
        // service itself does for a schema failure.
        ctx.effect(() => scope.watch((next) => {
            if (isUsableSettings(next)) live = next;
        }));
    };
    if (deps.settings) bindSettings(deps.settings);
    else if (typeof ctx.inject === 'function') {
        ctx.inject(['settings'], (settingsCtx: { settings: SettingsSeam }) => bindSettings(settingsCtx.settings));
    }

    // Best-effort boot check: prefetch capabilities for the default model and
    // warn once when a configured default violates its record. Contained — an
    // offline boot must not fail the plugin.
    ctx.effect(() => {
        void (async () => {
            const entry = config.models?.[config.defaultModel];
            if (!entry?.id) return;
            const record = await capabilities.get(entry.id);
            if (!record?.supported_parameters) return;
            for (const [key, value] of Object.entries(entry.defaults ?? {})) {
                const desc = record.supported_parameters[key];
                if (!desc) {
                    console.warn(`[dsh-tool-imagegen] model ${entry.id} does not support default "${key}" — it will be dropped at call time.`);
                } else {
                    try {
                        buildParams({ call: {}, defaults: { [key]: value }, descriptor: record.supported_parameters, descriptorKnown: true, alias: config.defaultModel, modelId: entry.id });
                    } catch (error) {
                        console.warn(`[dsh-tool-imagegen] ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }
        })();
        return () => { /* nothing to dispose */ };
    });

    ctx.tools.register(defineTool({
        name: 'generate_image',
        description:
            'Generate an image from a text prompt and save it into the workspace. '
            + 'Returns the file paths. Use when the user asks for an image, mockup, '
            + 'illustration or texture — not for reading or describing existing images.',
        parameters: {
            prompt: { type: 'string', required: true, description: 'What to depict.' },
            model: { type: 'string', description: 'Configured model alias; defaults to the configured defaultModel.' },
            resolution: { type: 'string', description: 'Output tier, e.g. 1K | 2K | 4K — model dependent.' },
            aspect_ratio: { type: 'string', description: 'Aspect ratio, e.g. 1:1, 16:9 — model dependent.' },
            n: { type: 'integer', description: `How many images (default 1, at most ${config.maxImagesPerCall}).` },
            seed: { type: 'integer', description: 'Seed for reproducible output, when the model supports it.' },
            output_format: { type: 'string', description: 'Encoding of the returned image, e.g. png | jpeg — model dependent, most models decide it themselves.' },
            input_references: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Reference images to edit or vary, as workspace paths or http(s) URLs. '
                    + 'Only for models that accept them; how many is model dependent.',
            },
            output_path: { type: 'string', description: 'Target path for the first image, absolute or workspace-relative. The extension follows the returned encoding.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    model: { type: 'string', required: true },
                    alias: { type: 'string', required: true },
                    images: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                mediaType: { type: 'string', required: true },
                                bytes: { type: 'integer', required: true },
                            },
                        },
                    },
                    costUsd: { type: 'number', required: true },
                    applied: { type: 'object', required: true, additionalProperties: true },
                    droppedDefaults: { type: 'array', required: true, items: { type: 'string' } },
                    attachments: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                attachmentId: { type: 'string', required: true },
                                mediaType: { type: 'string', required: true },
                                bytes: { type: 'integer', required: true },
                                width: { type: 'integer', required: true },
                                height: { type: 'integer', required: true },
                                name: { type: 'string' },
                                originalDimensions: {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        width: { type: 'integer', required: true },
                                        height: { type: 'integer', required: true },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const v = value as {
                    model: string; images: { path: string }[]; costUsd: number; droppedDefaults: string[];
                };
                const lines = [
                    `Generated ${v.images.length} image(s) with ${v.model} (${v.costUsd.toFixed(4)} USD):`,
                    ...v.images.map((i) => i.path),
                ];
                if (v.droppedDefaults.length > 0) {
                    lines.push(`Dropped unsupported config defaults: ${v.droppedDefaults.join(', ')}`);
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
            presentationMeta: (_args, value) => {
                const v = value as {
                    model: string; alias: string; images: { path: string; mediaType: string }[];
                    attachments?: { attachmentId: string; mediaType: string }[];
                };
                return {
                    model: v.model,
                    alias: v.alias,
                    images: v.images.map((i) => ({ path: i.path, mediaType: i.mediaType })),
                    ...(v.attachments ? { attachments: v.attachments } : {}),
                };
            },
        },
        // Image generation can take minutes at 4K; the body forwards exec.signal.
        timeoutMs: IMAGEGEN_TIMEOUT_MS,
        isConcurrencySafe: () => true,
        presentCall: (args) => {
            const a = args as { prompt?: unknown; output_path?: unknown; input_references?: unknown };
            const prompt = typeof a.prompt === 'string' ? a.prompt : '';
            const excerpt = prompt.length > PROMPT_CARD_EXCERPT
                ? `${prompt.slice(0, PROMPT_CARD_EXCERPT)}…` : prompt;
            // An image-to-image call must not look like a text-to-image one on the card.
            const refs = Array.isArray(a.input_references) ? a.input_references.length : 0;
            const refLine = refs === 0 ? undefined
                : refs === 1 ? 'mit 1 Referenzbild' : `mit ${refs} Referenzbildern`;
            // When the call names its target file, declare the mutation intent:
            // the deliverables row (produced-files chips) and inline-code mention
            // links key off a generic card with kind 'edit' + locations.
            const outputPath = typeof a.output_path === 'string' ? a.output_path.trim() : '';
            const locations = outputPath ? [{ path: outputPath }] : undefined;
            return {
                card: 'generic',
                title: refLine ? `Bild generieren · ${refLine}` : 'Bild generieren',
                kind: locations ? 'edit' : 'other',
                content: excerpt ? [{ type: 'text', text: excerpt }] : undefined,
                locations,
            };
        },
        presentResult: (_args, result) => {
            if (result.isError) return undefined;
            // Pure projection of the persisted meta — survives session-log replay.
            const meta = result.meta as { model?: string; images?: { path: string }[] } | undefined;
            const paths = meta?.images?.map((i) => i.path) ?? [];
            if (paths.length === 0) return undefined;
            return {
                card: 'generic',
                title: `Bild generiert${meta?.model ? ` · ${meta.model}` : ''}`,
                content: paths.map((p) => ({ type: 'text', text: p })),
            };
        },
        async execute(args, exec) {
            // 1. Hand checks + alias + key.
            const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
            if (!prompt) throw new Error('generate_image requires a non-empty "prompt".');
            const n = args.n ?? 1;
            if (!Number.isInteger(n) || n < 1) {
                throw new Error(`Invalid n: ${JSON.stringify(args.n)} — must be an integer >= 1.`);
            }
            // One snapshot per call: a commit landing mid-call must not change
            // the rules the call is already being judged by.
            const settings = live;
            if (n > settings.maxImagesPerCall) {
                throw new Error(`n = ${n} exceeds the configured maxImagesPerCall = ${settings.maxImagesPerCall}.`);
            }
            const alias = (args.model ?? '').trim() || settings.defaultModel;
            const entry = resolveModel(settings, alias);
            // Reference images resolve like every other parameter: call argument
            // → alias default → none. Only the LIST is resolved here; the files
            // are read after the gate has said the model can use them.
            const referenceOrigin = args.input_references !== undefined ? 'call' : 'default';
            const referenceArg = args.input_references ?? entry.defaults?.input_references;
            const references = referenceArg === undefined ? undefined : asReferenceList(referenceArg, referenceOrigin, alias);
            // Credentials seam first (covers $DSH_HOME/.credentials.yaml and the
            // provider's env layers), then the same-named environment variable.
            const apiKey = await resolveApiKey(credentials, config.apiKeyEnv);
            if (!apiKey) {
                throw new Error(
                    `Missing API key: no dsh credential "${config.apiKeyEnv}" and no environment variable of that name. `
                    + `Add it to $DSH_HOME/.credentials.yaml under refs.${config.apiKeyEnv}, or export the environment variable.`,
                );
            }

            // The workspace root is the SESSION's validated cwd
            // (exec.agent.session.header.cwd) — the server process cwd is NOT
            // the workspace in web deployments. Reference paths resolve against
            // it exactly as output paths do.
            const workspaceRoot = deps.workspaceRoot
                ?? exec.agent?.session.header.cwd
                ?? process.cwd();

            // 2. Capability gate (once; on a 400 invalidate once and retry).
            const attempt = async () => {
                const record = await capabilities.get(entry.id, exec.signal);
                const gate = buildParams({
                    call: args as Record<string, unknown>,
                    defaults: entry.defaults ?? {},
                    descriptor: record?.supported_parameters,
                    descriptorKnown: record !== undefined,
                    alias,
                    modelId: entry.id,
                });
                let sendReferences = false;
                if (references !== undefined) {
                    sendReferences = gateReferences({
                        count: references.length,
                        descriptor: record?.supported_parameters,
                        descriptorKnown: record !== undefined,
                        origin: referenceOrigin,
                        alias,
                        modelId: entry.id,
                    }) === 'send';
                    if (!sendReferences && referenceOrigin === 'default' && references.length > 0) {
                        gate.droppedDefaults.push('input_references');
                    }
                }
                return { gate, hadRecord: capabilities.hasRecord, sendReferences };
            };

            // Reading and encoding happens once, after the gate approved the
            // list — a retry re-gates but never re-reads the files.
            let encoded: ImageReference[] | undefined;
            const bodyParams = async (outcome: Awaited<ReturnType<typeof attempt>>) => {
                if (!outcome.sendReferences || references === undefined) return outcome.gate.params;
                encoded ??= await readReferences({
                    values: references,
                    workspaceRoot,
                    maxBytes: settings.maxReferenceBytes,
                    maxTotalBytes: settings.maxReferenceTotalBytes,
                    signal: exec.signal,
                });
                return { ...outcome.gate.params, input_references: encoded.map(toWireReference) };
            };

            let outcome = await attempt();
            let generation;
            try {
                generation = await generateImage({
                    baseURL: config.baseURL,
                    apiKey,
                    model: entry.id,
                    prompt,
                    params: await bodyParams(outcome),
                    signal: exec.signal,
                    fetchImpl: deps.fetchImpl,
                });
            } catch (error) {
                if (error instanceof OpenRouterHttpError && error.status === 400 && outcome.hadRecord) {
                    // The cached capability record may be stale — refetch once and re-gate.
                    capabilities.invalidate();
                    outcome = await attempt();
                    generation = await generateImage({
                        baseURL: config.baseURL,
                        apiKey,
                        model: entry.id,
                        prompt,
                        params: await bodyParams(outcome),
                        signal: exec.signal,
                        fetchImpl: deps.fetchImpl,
                    });
                } else {
                    throw error;
                }
            }
            const gate = outcome.gate;

            // 3. Decode + write into the workspace.
            const baseName = `${sanitizeName(alias)}-${timestampForName()}`;
            const written = await writeImages({
                images: generation.images,
                dir: settings.outputDir,
                baseName,
                outputPath: args.output_path,
                workspaceRoot,
                signal: exec.signal,
            });

            // 3b. Chat display: commit the images into the attachment store,
            // put the refs into the result meta (the client half's tool card
            // renders them), and defer a plugin-sourced message so the model
            // sees the picture too. Entirely contained — a store outage must
            // never fail an otherwise successful generation.
            let attached: ChatImage[] | undefined;
            if (settings.showInChat && attachments) {
                try {
                    const chatImages: ChatImage[] = [];
                    for (let i = 0; i < generation.images.length; i++) {
                        const image = generation.images[i];
                        const mediaType = image.mediaType ?? 'image/png';
                        if (!isAttachableMediaType(mediaType)) continue; // e.g. SVG: path-only
                        const name = written[i].path.split('/').pop() ?? `${baseName}-${i + 1}`;
                        const ref = await attachments.saveImage(toSaveInput(image.b64, mediaType, name));
                        chatImages.push({ ref, path: written[i].path });
                    }
                    const message = buildChatMessage(chatImages, entry.id);
                    if (message) {
                        exec.deferContext(message);
                        attached = chatImages;
                    }
                } catch {
                    // Contained: chat display is best-effort.
                }
            }

            // 4. Canonical value.
            return {
                model: entry.id,
                alias,
                images: written.map((w) => ({ path: w.path, mediaType: w.mediaType, bytes: w.bytes })),
                costUsd: generation.costUsd,
                // The sources, never the payload: `applied` is logged, and one
                // 4K reference is megabytes of base64.
                applied: outcome.sendReferences && references !== undefined
                    ? { ...gate.params, input_references: references }
                    : gate.params,
                droppedDefaults: gate.droppedDefaults,
                ...(attached ? { attachments: attached.map((c) => toValueRef(c.ref)) } : {}),
            };
        },
    }));
}

/**
 * Apply the plugin with the real environment: register the `generate_image` tool.
 * @param ctx - plugin context; the injected services are ready at this point.
 * @param config - validated Schemastery configuration (defaults applied).
 */
export function apply(ctx: Context, config: PluginConfig): void {
    applyWithDeps(ctx, config);
}
