/**
 * Chat display of generated images.
 *
 * Saves generated images into the durable attachment store and builds the
 * plugin-sourced user message that `execute` defers via `exec.deferContext`.
 * The message is what puts the picture in front of the MODEL; adapters without
 * image input fall back to the text placeholder machinery.
 *
 * It is NOT what puts the picture in front of the reader: a message whose
 * `source.kind` is not `user` is classified as injected context, and the
 * context row presents text blocks only — an image block there renders as the
 * UI's unknown-block fallback. The visible image is the client half's keyed
 * tool card, which loads the same attachment refs out of the result meta. What
 * this module buys the reader is the `notice` form's one-line summary on the
 * collapsed row.
 * @module dsh-tool-imagegen/chat
 */
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment';

/** Minimal structural view of the attachment store (ctx.attachments). */
export interface AttachmentSeam {
    saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>;
}

/** Media types the attachment service accepts; anything else (e.g. SVG) is skipped. */
const ATTACHABLE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function isAttachableMediaType(mediaType: string): boolean {
    return ATTACHABLE_MEDIA_TYPES.includes(mediaType);
}

/** Decode one generated image for the attachment store. */
export function toSaveInput(b64: string, mediaType: string, name: string): SaveImageAttachment {
    return {
        data: new Uint8Array(Buffer.from(b64, 'base64')),
        mediaType: mediaType as ImageMediaType,
        name,
    };
}

export interface ChatImage {
    ref: ImageAttachmentRef;
    path: string;
}

/** Fields of an `ImageAttachmentRef` the tool's canonical output schema declares.
 * The store may attach more (e.g. `originalDimensions` after normalization, or
 * future metadata) — the whitelist keeps the canonical value schema-valid under
 * `additionalProperties: false`. */
const REF_VALUE_FIELDS = [
    'attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name', 'originalDimensions',
] as const;

/** Project one store ref onto the schema-declared fields (lossless within the declared shape). */
export function toValueRef(ref: ImageAttachmentRef): ImageAttachmentRef {
    const source = ref as unknown as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const field of REF_VALUE_FIELDS) {
        if (source[field] !== undefined) projected[field] = source[field];
    }
    return projected as unknown as ImageAttachmentRef;
}

/**
 * The collapsed context row's one-line account.
 *
 * The `notice` form is the honest one for this message: a one-off report that
 * something just happened, superseding nothing. Declaring it costs one summary
 * and buys a readable collapsed row — without it the row shows only the plugin
 * name, and the image block (which this UI generation has no context-row
 * presentation for) is the only thing left to look at.
 */
export function chatSummary(images: readonly ChatImage[]): string {
    return boundContextSummary(images.length === 1
        ? `Bild erzeugt: ${images[0].path}`
        : `${images.length} Bilder erzeugt: ${images.map((i) => i.path).join(', ')}`);
}

/**
 * Build the deferred chat message: one image block per attached image,
 * followed by one compact text block with the workspace paths. Returns
 * `undefined` when nothing is attachable (e.g. SVG-only output).
 */
export function buildChatMessage(images: readonly ChatImage[], model: string) {
    if (images.length === 0) return undefined;
    const content = [
        ...images.map((img) => ({ type: 'image' as const, attachment: img.ref })),
        {
            type: 'text' as const,
            text: images.length === 1
                ? `Generated with ${model}: ${images[0].path}`
                : `Generated ${images.length} images with ${model}:\n${images.map((i) => i.path).join('\n')}`,
        },
    ];
    return createUserMessage({
        content,
        source: {
            kind: 'plugin',
            plugin: 'dsh-tool-imagegen',
            form: 'notice',
            summary: chatSummary(images),
        },
    });
}
