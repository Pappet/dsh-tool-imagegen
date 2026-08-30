/**
 * Reference images for image-to-image generation.
 *
 * Turns what a tool call names — a workspace path or an HTTP(S) URL — into the
 * `input_references` entries the OpenRouter Image API accepts. Node-only (fs)
 * but harness-free: no DSH imports, every input injected.
 *
 * A URL is the caller's business and passes through untouched; a path is read,
 * capped, identified by its MAGIC BYTES and inlined as a base64 data URL. The
 * bytes decide the media type, never the file name: this plugin itself used to
 * write JPEG payloads under a `.png` name (see `withMediaExtension`), and a
 * data URL that mislabels its payload fails at the provider with an error that
 * points nowhere near the cause.
 * @module dsh-tool-imagegen/references
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/** Media types accepted as reference input; anything else is a hard error. */
export const REFERENCE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** One resolved reference, ready for the request body. */
export interface ImageReference {
    /** Exactly what the call named, echoed into the result (never the payload). */
    source: string;
    /** HTTP(S) URL passed through, or a base64 data URL built from the file. */
    url: string;
    /** Sniffed media type; absent for a passed-through URL. */
    mediaType?: string;
    /** Encoded byte length on disk; absent for a passed-through URL. */
    bytes?: number;
}

const MAGIC: readonly { mediaType: string; offset: number; bytes: readonly number[] }[] = [
    { mediaType: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { mediaType: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
    { mediaType: 'image/gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8(7|9)a
    { mediaType: 'image/webp', offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF….WEBP
];

/** The WebP container repeats its format tag after the RIFF size field. */
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];

function matches(data: Uint8Array, offset: number, bytes: readonly number[]): boolean {
    if (data.length < offset + bytes.length) return false;
    return bytes.every((b, i) => data[offset + i] === b);
}

/**
 * Identify image bytes by their container signature.
 * @param data - the first bytes of a file (the whole file is fine).
 * @returns the media type, or `undefined` when the bytes are not a supported image.
 */
export function sniffMediaType(data: Uint8Array): string | undefined {
    for (const sig of MAGIC) {
        if (!matches(data, sig.offset, sig.bytes)) continue;
        if (sig.mediaType === 'image/webp') return matches(data, 8, WEBP_TAG) ? 'image/webp' : undefined;
        return sig.mediaType;
    }
    return undefined;
}

/** Project one reference onto the API's content-block shape. */
export function toWireReference(ref: ImageReference): { type: 'image_url'; image_url: { url: string } } {
    return { type: 'image_url', image_url: { url: ref.url } };
}

export interface ReadReferencesOptions {
    /** Paths (absolute or workspace-relative) and/or HTTP(S) URLs, in call order. */
    values: readonly string[];
    /** Root for resolving relative paths — the SESSION cwd, as for output paths. */
    workspaceRoot: string;
    /** Per-file cap on the encoded bytes read from disk. */
    maxBytes: number;
    /** Cap on the encoded bytes of all file references together. */
    maxTotalBytes: number;
    signal?: AbortSignal;
}

function isHttpUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

/**
 * Resolve every reference the call named, in order.
 *
 * Caps are measured on the bytes ON DISK, which is what the caller can see and
 * fix; the base64 encoding adds roughly a third on the wire.
 * @param opts - the named values, the workspace root, and the byte caps.
 * @returns one resolved reference per input value, in input order.
 * @throws when a path cannot be read, holds unsupported bytes, or breaks a cap.
 */
export async function readReferences(opts: ReadReferencesOptions): Promise<ImageReference[]> {
    const refs: ImageReference[] = [];
    let total = 0;
    for (const value of opts.values) {
        if (opts.signal?.aborted) throw new Error('Aborted while reading reference images');
        if (isHttpUrl(value)) {
            refs.push({ source: value, url: value });
            continue;
        }
        const path = isAbsolute(value) ? value : resolve(opts.workspaceRoot, value);
        let data: Buffer;
        try {
            data = await readFile(path);
        } catch (error) {
            throw new Error(
                `Reference image "${value}" could not be read (resolved to ${path}): `
                + `${error instanceof Error ? error.message : String(error)}`,
            );
        }
        if (data.byteLength > opts.maxBytes) {
            throw new Error(
                `Reference image "${value}" is ${data.byteLength} bytes, over the `
                + `imagegen.maxReferenceBytes limit of ${opts.maxBytes}.`,
            );
        }
        total += data.byteLength;
        if (total > opts.maxTotalBytes) {
            throw new Error(
                `The reference images total ${total} bytes, over the `
                + `imagegen.maxReferenceTotalBytes limit of ${opts.maxTotalBytes}.`,
            );
        }
        const mediaType = sniffMediaType(data);
        if (mediaType === undefined) {
            throw new Error(
                `Reference image "${value}" is not a supported reference image: its bytes are not `
                + `${REFERENCE_MEDIA_TYPES.join(', ')}. (The file NAME is not consulted — the bytes are.)`,
            );
        }
        refs.push({
            source: value,
            url: `data:${mediaType};base64,${data.toString('base64')}`,
            mediaType,
            bytes: data.byteLength,
        });
    }
    return refs;
}
