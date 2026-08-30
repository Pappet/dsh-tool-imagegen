/**
 * OpenRouter unified Image API client.
 *
 * Knows no DSH: every environment dependency (fetch implementation, abort
 * signal, credentials) is injected, so the module is testable without a
 * running harness. Endpoints are `/images/models` (capability records) and
 * `/images` (generation) — NOT the OpenAI-compatible `/images/generations`.
 * @module dsh-tool-imagegen/openrouter
 */

/** Typed capability descriptor for one request field. */
export type CapabilityDescriptor =
    | { type: 'enum'; values: readonly string[] }
    | { type: 'range'; min: number; max: number }
    | { type: 'boolean' };

/** One entry of GET /images/models. */
export interface ImageModelRecord {
    id: string;
    supported_parameters?: Record<string, CapabilityDescriptor>;
    supports_streaming?: boolean;
}

/** One generated image as returned by the API. */
export interface ImageResult {
    b64: string;
    mediaType?: string;
}

/** Normalized POST /images response. */
export interface GenerationResponse {
    images: ImageResult[];
    /** Exact USD cost from `usage.cost`; 0 when the API omitted it. */
    costUsd: number;
    /** The raw response body, kept for diagnostics only. */
    raw: unknown;
}

/** HTTP failure carrying status AND body text — the body carries OpenRouter's
 * repairable detail (which parameter was wrong and why). */
export class OpenRouterHttpError extends Error {
    readonly status: number;
    readonly body: string;
    readonly url: string;
    constructor(status: number, body: string, url: string) {
        super(`OpenRouter ${url} failed with HTTP ${status}: ${body}`);
        this.name = 'OpenRouterHttpError';
        this.status = status;
        this.body = body;
        this.url = url;
    }
}

export interface ClientBase {
    baseURL: string;
    apiKey?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
}

function authHeaders(apiKey?: string): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function readBodySnippet(res: Response, cap = 2000): Promise<string> {
    try {
        const text = await res.text();
        return text.length > cap ? `${text.slice(0, cap)}…` : text;
    } catch {
        return `<unreadable body>`;
    }
}

/** GET {baseURL}/images/models — the image-model list with capability records. */
export async function fetchImageModels(opts: ClientBase): Promise<ImageModelRecord[]> {
    const url = `${opts.baseURL.replace(/\/$/, '')}/images/models`;
    const res = await (opts.fetchImpl ?? fetch)(url, {
        headers: authHeaders(opts.apiKey),
        signal: opts.signal,
    });
    if (!res.ok) throw new OpenRouterHttpError(res.status, await readBodySnippet(res), url);
    const body: unknown = await res.json();
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
        throw new Error(`OpenRouter ${url} returned no "data" array: ${JSON.stringify(body).slice(0, 200)}`);
    }
    return data as ImageModelRecord[];
}

export interface GenerateImageOptions extends ClientBase {
    /** OpenRouter model slug. */
    model: string;
    prompt: string;
    /** Gated generation parameters, sent as top-level body fields. */
    params: Record<string, unknown>;
}

/** POST {baseURL}/images — one text-to-image generation. */
export async function generateImage(opts: GenerateImageOptions): Promise<GenerationResponse> {
    const url = `${opts.baseURL.replace(/\/$/, '')}/images`;
    const res = await (opts.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: { ...authHeaders(opts.apiKey), 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, prompt: opts.prompt, ...opts.params }),
        signal: opts.signal,
    });
    if (!res.ok) throw new OpenRouterHttpError(res.status, await readBodySnippet(res), url);
    const body: unknown = await res.json();
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`OpenRouter ${url} returned no image data: ${JSON.stringify(body).slice(0, 200)}`);
    }
    const images: ImageResult[] = data.map((entry, i) => {
        const b64 = (entry as { b64_json?: unknown })?.b64_json;
        if (typeof b64 !== 'string' || b64.length === 0) {
            throw new Error(`OpenRouter ${url} image #${i} has no b64_json payload: ${JSON.stringify(entry).slice(0, 200)}`);
        }
        const mediaType = (entry as { media_type?: unknown })?.media_type;
        return { b64, mediaType: typeof mediaType === 'string' ? mediaType : undefined };
    });
    const cost = (body as { usage?: { cost?: unknown } })?.usage?.cost;
    return {
        images,
        costUsd: typeof cost === 'number' ? cost : 0,
        raw: body,
    };
}
