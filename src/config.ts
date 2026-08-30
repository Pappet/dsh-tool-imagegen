/**
 * Schemastery configuration for dsh-tool-imagegen.
 *
 * Every tunable is changeable from cordis.yml (or an overlay patch row's
 * `config`); the schema validates at load time. Secrets are NOT config
 * fields: the API key is resolved at call time through the dsh credentials
 * seam first (covering $DSH_HOME/.credentials.yaml and the provider's env
 * layers), then from the same-named process environment variable — the
 * reference NAME is the `apiKeyEnv` config field, mirroring `llm-pi-ai`.
 * @module dsh-tool-imagegen/config
 */
import z from '@deepseek-ai/schemastery';

/** One configured model alias. */
export const ImagegenModelConfig = z.object({
    id: z.string()
        .description('OpenRouter model slug as listed by GET /images/models, e.g. bytedance-seed/seedream-4.5.'),
    defaults: z.dict(z.any())
        .description('Default generation parameters for this alias (e.g. resolution, aspect_ratio). '
            + 'Defaults are wishes, not promises: an unsupported key is silently dropped, '
            + 'a value outside the model capability record fails the call with a config-attributed error.'),
});

export const Config = z.object({
    apiKeyEnv: z.string()
        .pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .default('OPENROUTER_API_KEY')
        .description('Credential reference / environment variable name holding the OpenRouter API key '
            + '(resolved via the credentials seam first, then the environment).'),
    baseURL: z.string()
        .default('https://openrouter.ai/api/v1')
        .description('OpenRouter API base URL. The tool posts to {baseURL}/images and reads {baseURL}/images/models.'),
    outputDir: z.string()
        .default('.dsh/images')
        .description('Directory for generated images, workspace-relative (absolute paths are honored).'),
    defaultModel: z.string()
        .default('seedream')
        .description('Model alias used when the tool call does not name one.'),
    capabilityTtlMs: z.number()
        .min(0)
        .default(86_400_000)
        .description('How long the /images/models capability cache stays fresh (default 24 h). '
            + 'It is additionally invalidated once on a 400 and refetched.'),
    maxImagesPerCall: z.number()
        .step(1)
        .min(1)
        .max(20)
        .default(4)
        .description('Own upper bound on n per call, independent of the endpoint range; guards against hallucinated n values.'),
    maxReferenceBytes: z.number()
        .step(1)
        .min(1)
        .default(8 * 1024 * 1024)
        .description('Per-file cap on a reference image read from disk for image-to-image calls (default 8 MiB). '
            + 'Measured on the bytes on disk; the base64 encoding adds roughly a third on the wire.'),
    maxReferenceTotalBytes: z.number()
        .step(1)
        .min(1)
        .default(32 * 1024 * 1024)
        .description('Cap on all reference images of one call together (default 32 MiB). '
            + 'A model may accept up to 14 references, which is how a single call gets large.'),
    models: z.dict(ImagegenModelConfig)
        .description('Model aliases. The alias is what the model names in the tool call (and the allowlist: '
            + 'a model not configured here is unreachable).'),
    showInChat: z.boolean()
        .default(true)
        .description('Display generated images in the chat: the images are committed to the attachment '
            + 'store, the tool card renders them inline, and the deferred message puts them into the model '
            + 'context (text-only adapters see a text placeholder). Requires the deployment to have an '
            + 'attachment service.'),
});

/** Validated plugin configuration (Schemastery output). */
export interface PluginConfig {
    apiKeyEnv: string;
    baseURL: string;
    outputDir: string;
    defaultModel: string;
    capabilityTtlMs: number;
    maxImagesPerCall: number;
    maxReferenceBytes: number;
    maxReferenceTotalBytes: number;
    showInChat?: boolean;
    models?: Record<string, ImagegenModelEntry>;
}

/** One configured model alias, as seen after validation. */
export interface ImagegenModelEntry {
    id: string;
    defaults?: Record<string, unknown>;
}
