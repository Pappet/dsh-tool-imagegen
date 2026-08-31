/**
 * User-settings namespace backing the browser configuration card.
 *
 * The card in the "Plugins" settings section edits THIS namespace, not the
 * cordis entry config. The two are layered, not alternatives:
 *
 * ```
 * schema defaults  →  base (the cordis config)  →  user layer (the card)
 * ```
 *
 * so `cordis.patch.yml` stays the deployment's stated intent and a card edit is
 * an override on top of it — clearing a field falls back to exactly the
 * configured value rather than to a schema default nobody chose.
 *
 * Only tunables live here. `apiKeyEnv`, `baseURL` and `capabilityTtlMs` stay
 * config-only: they are deployment decisions, and the capability cache is
 * built from them once at apply time, so a live edit could not take effect
 * without rebuilding it.
 * @module dsh-tool-imagegen/settings
 */
import z from '@deepseek-ai/schemastery';
import { type ImagegenModelEntry, type PluginConfig } from './config.js';

/** Namespace grammar as the settings service states it: lowercase kebab-case. */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Validate a settings namespace.
 *
 * dsh-settings exports a `settingsNamespace` helper that does exactly this,
 * and importing it is the obvious move — but that export moves. The 0.1.2
 * alpha line dropped it (and `installSettingsSection`) outright, and every
 * plugin that imported them failed to LOAD, taking the whole plugin tree down
 * with a `SyntaxError` before any of them could run. A three-line pattern
 * check is not worth that coupling, so this plugin owns its copy and runs on
 * either line. The grammar has to stay in step with the service, which is
 * cheap: it is one regex, and a namespace it rejects would be refused at
 * registration anyway.
 * @param value - candidate namespace; lowercase kebab-case, as in plugin short names.
 * @returns the namespace, unchanged.
 */
export function settingsNamespace(value: string): string {
    if (!NAMESPACE_PATTERN.test(value)) {
        throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
    }
    return value;
}

/** The namespace the settings card is keyed on, in both halves. */
export const IMAGEGEN_SETTINGS_NAMESPACE = settingsNamespace('dsh-tool-imagegen');

/**
 * One alias row.
 *
 * A LIST, not the config's dict, and the reason is the layering: `mergeLayers`
 * merges plain objects recursively and replaces arrays wholesale, so a dict in
 * the user layer could never delete an alias the composition base declares —
 * removing a row would silently re-inherit it from `cordis.yml`. As a list the
 * user layer replaces the registry outright, which is what "remove this alias"
 * has to mean. It also gives the card a stable row order.
 */
export const ImagegenModelSetting = z.object({
    alias: z.string()
        .description('Name the model uses in a tool call.'),
    id: z.string()
        .description('OpenRouter model slug, e.g. bytedance-seed/seedream-4.5.'),
    defaults: z.dict(z.any())
        .description('Default parameters for this alias; unsupported ones are dropped per call.'),
});

/**
 * Settings surface for the configuration card. The tunables a person edits;
 * the descriptions are what the card renders as hints, so they address the
 * person editing, not the deployment author.
 */
export const ImagegenSettingsSchema = z.object({
    models: z.array(ImagegenModelSetting)
        .description('Model aliases. The alias is what the model names in a tool call, and the allowlist: '
            + 'a model without an alias cannot be reached.'),
    defaultModel: z.string()
        .description('Alias used when a tool call names none.'),
    outputDir: z.string()
        .description('Where generated images are written, relative to the workspace.'),
    showInChat: z.boolean()
        .description('Show generated images in the chat and put them into the model context.'),
    maxImagesPerCall: z.number().step(1).min(1).max(20)
        .description('Upper bound on how many images one call may produce.'),
    maxReferenceBytes: z.number().step(1).min(1)
        .description('Largest single reference image accepted for image-to-image, in bytes.'),
    maxReferenceTotalBytes: z.number().step(1).min(1)
        .description('Largest total of all reference images of one call, in bytes.'),
});

/** One configured alias as the settings document carries it. */
export interface ImagegenModelSettingEntry extends ImagegenModelEntry {
    alias: string;
}

/** The live, resolved settings the tool reads per call. */
export interface ImagegenSettings {
    models: ImagegenModelSettingEntry[];
    defaultModel: string;
    outputDir: string;
    showInChat: boolean;
    maxImagesPerCall: number;
    maxReferenceBytes: number;
    maxReferenceTotalBytes: number;
}

/**
 * Project the entry config onto the settings shape — the composition `base`
 * the user layer resolves over, and the fallback when no settings service
 * exists (a headless deployment keeps working, unconfigurable).
 * @param config - the validated entry config.
 * @returns the settings-shaped subset of it.
 */
export function settingsFromConfig(config: PluginConfig): ImagegenSettings {
    return {
        models: Object.entries(config.models ?? {}).map(([alias, entry]) => ({
            alias,
            id: entry.id,
            defaults: entry.defaults ?? {},
        })),
        defaultModel: config.defaultModel,
        outputDir: config.outputDir,
        showInChat: config.showInChat !== false,
        maxImagesPerCall: config.maxImagesPerCall,
        maxReferenceBytes: config.maxReferenceBytes,
        maxReferenceTotalBytes: config.maxReferenceTotalBytes,
    };
}

/** Minimal structural view of one registered namespace (ctx.settings). */
export interface SettingsSeam {
    register(
        ns: unknown,
        schema: unknown,
        options?: { base?: unknown; applies?: 'live' | 'restart'; validate?: (value: never) => void },
    ): { get(): unknown; watch(cb: (next: unknown, prev: unknown) => void): () => void };
}

/**
 * A settings value is only usable when it carries a model registry; anything
 * else means the document was hand-edited into a state the tool cannot act on.
 * @param value - a resolved section from the settings service.
 * @returns whether it can replace the live settings.
 */
export function isUsableSettings(value: unknown): value is ImagegenSettings {
    if (typeof value !== 'object' || value === null) return false;
    const models = (value as { models?: unknown }).models;
    if (!Array.isArray(models)) return false;
    return models.every((entry) => typeof entry === 'object' && entry !== null
        && typeof (entry as { alias?: unknown }).alias === 'string'
        && typeof (entry as { id?: unknown }).id === 'string');
}

/**
 * Cross-field check the schema cannot express, run by the settings service on
 * every write: two rows claiming one alias would make the allowlist ambiguous,
 * and the loser would vanish from the UI with no account of why. Throwing here
 * refuses the WRITE, so the card learns at save time instead of storing
 * something the tool cannot act on.
 * @param value - the resolved section, schema-valid by construction.
 */
export function validateSettings(value: ImagegenSettings): void {
    const seen = new Set<string>();
    for (const entry of value.models) {
        const alias = entry.alias.trim();
        if (alias === '') throw new Error('imagegen: a model alias must not be empty.');
        if (entry.id.trim() === '') throw new Error(`imagegen: alias "${alias}" names no model slug.`);
        if (seen.has(alias)) throw new Error(`imagegen: alias "${alias}" is listed more than once.`);
        seen.add(alias);
    }
}
