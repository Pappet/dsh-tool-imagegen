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
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { ImagegenModelConfig, type ImagegenModelEntry, type PluginConfig } from './config.js';

/** The namespace the settings card is keyed on, in both halves. */
export const IMAGEGEN_SETTINGS_NAMESPACE = settingsNamespace('dsh-tool-imagegen');

/** The namespace as a plain string, for the browser half's slot key. */
export const IMAGEGEN_SETTINGS_NS = 'dsh-tool-imagegen';

/**
 * Settings surface for the configuration card. Field-for-field a subset of
 * {@link PluginConfig}; the descriptions are what the card renders as hints,
 * so they address the person editing, not the deployment author.
 */
export const ImagegenSettingsSchema = z.object({
    models: z.dict(ImagegenModelConfig)
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

/** The live, resolved settings the tool reads per call. */
export interface ImagegenSettings {
    models: Record<string, ImagegenModelEntry>;
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
        models: config.models ?? {},
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
        options?: { base?: unknown; applies?: 'live' | 'restart' },
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
    return typeof models === 'object' && models !== null;
}
