/**
 * Decode and persist generated images.
 *
 * Node-only (fs) but harness-free: no DSH imports, all inputs injected.
 * @module dsh-tool-imagegen/write
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ImageResult } from './openrouter.js';

/** Extensions that honestly name one media type, canonical spelling first.
 * More than one entry means the alternates are equally correct — `.jpeg` is
 * not renamed to `.jpg` just because the map lists `jpg` first. */
const EXTENSIONS_FOR_MEDIA_TYPE: Record<string, readonly string[]> = {
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/webp': ['webp'],
    'image/svg+xml': ['svg'],
    'image/gif': ['gif'],
};

/** File extension for a media type; defaults to `png`. */
export function extForMediaType(mediaType: string | undefined): string {
    return (mediaType ? EXTENSIONS_FOR_MEDIA_TYPE[mediaType]?.[0] : undefined) ?? 'png';
}

/**
 * Make a path's extension agree with the bytes it will hold.
 *
 * `output_path` names the file, but the model decides the encoding: a call
 * asking for `bild.png` from a model that only emits JPEG produced a `.png`
 * file full of JPEG bytes. The name is the caller's, the encoding is not, so
 * the extension follows the bytes.
 *
 * Only a KNOWN media type may rewrite a path. An absent or unrecognized one
 * means nothing is known about the encoding, and a guess would be worse than
 * the caller's own choice.
 * @param path - the caller's target path.
 * @param mediaType - the media type of the bytes about to be written.
 * @returns the path, with its extension corrected or appended when needed.
 */
export function withMediaExtension(path: string, mediaType: string | undefined): string {
    const accepted = mediaType ? EXTENSIONS_FOR_MEDIA_TYPE[mediaType] : undefined;
    if (accepted === undefined) return path;
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    const hasExt = dot > slash + 1;
    if (hasExt && accepted.includes(path.slice(dot + 1).toLowerCase())) return path;
    return `${hasExt ? path.slice(0, dot) : path}.${accepted[0]}`;
}

/** Filesystem-safe alias for filenames. */
export function sanitizeName(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
}

/** `{YYYYMMDD}-{HHmmss}` in local time, for the default filename. */
export function timestampForName(date = new Date()): string {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** Insert `-${n}` before the extension. */
function withIndex(path: string, n: number): string {
    const dot = path.lastIndexOf('.');
    const slash = path.lastIndexOf('/');
    const hasExt = dot > slash + 1;
    return hasExt
        ? `${path.slice(0, dot)}-${n}${path.slice(dot)}`
        : `${path}-${n}`;
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/** First non-colliding candidate path. With `forceSuffix` the `-${n}` suffix is
 * always inserted (even for n = 1); otherwise n = 1 tries `candidate` itself.
 * On collision the suffix increments. `candidate` must NOT carry a suffix. */
export async function resolveUniquePath(candidate: string, startIndex = 1, forceSuffix = false): Promise<string> {
    let n = Math.max(1, startIndex);
    let path = forceSuffix || n !== 1 ? withIndex(candidate, n) : candidate;
    while (await exists(path)) {
        n += 1;
        path = withIndex(candidate, n);
    }
    return path;
}

export interface WriteImagesOptions {
    images: ImageResult[];
    /** Directory for generated images (used when `outputPath` is not absolute). */
    dir: string;
    /** Filename base WITHOUT extension, e.g. `seedream-20260817-141530`. */
    baseName: string;
    /** Optional explicit target for the FIRST image (absolute or workspace-relative). */
    outputPath?: string;
    /** Workspace root for resolving relative paths. */
    workspaceRoot: string;
    signal?: AbortSignal;
}

export interface WrittenImage {
    path: string;
    mediaType: string;
    bytes: number;
}

/** Decode every image and write it to disk. The first image honors
 * `outputPath`; with `n > 1` an index is inserted before the extension.
 * Already-written images are NOT removed on later failures. */
export async function writeImages(opts: WriteImagesOptions): Promise<WrittenImage[]> {
    const written: WrittenImage[] = [];
    for (const [i, image] of opts.images.entries()) {
        if (opts.signal?.aborted) throw new Error('Aborted before writing image');
        const ext = extForMediaType(image.mediaType);
        // Default names always carry the 1-based index: {baseName}-{index}.{ext}.
        // `outputPath` overrides the FIRST image verbatim; n > 1 inserts the index.
        let base: string;
        const outputPath = opts.outputPath;
        // With `outputPath` every image derives from it (first verbatim, others
        // indexed); without, default names always carry the 1-based index.
        const first = Boolean(outputPath && i === 0);
        if (outputPath) {
            const named = isAbsolute(outputPath) ? outputPath : resolve(opts.workspaceRoot, outputPath);
            base = withMediaExtension(named, image.mediaType);
        } else {
            base = join(resolve(opts.workspaceRoot, opts.dir), `${opts.baseName}.${ext}`);
        }
        const path = await resolveUniquePath(base, first ? 1 : i + 1, !first);
        const dir = dirname(path);
        await mkdir(dir, { recursive: true });
        const buf = Buffer.from(image.b64, 'base64');
        await writeFile(path, buf);
        written.push({ path, mediaType: image.mediaType ?? 'image/png', bytes: buf.byteLength });
    }
    return written;
}
