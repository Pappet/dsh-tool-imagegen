/**
 * Capability cache and parameter gate.
 *
 * The cache holds the GET /images/models records for `capabilityTtlMs` and is
 * additionally invalidated once on a 400 (see the tool's execute). The gate
 * assembles the request parameters and enforces the two error classes from
 * the design: a call-named parameter the model does not support is an ERROR,
 * while an unsupported CONFIG DEFAULT is silently dropped; a default value
 * outside the capability record fails closed with a config-attributed error.
 * @module dsh-tool-imagegen/capabilities
 */
import {
    fetchImageModels,
    type CapabilityDescriptor,
    type ClientBase,
    type ImageModelRecord,
} from './openrouter.js';
import type { JsonValue } from '@deepseek-ai/dsh-tools';

/** Request fields the tool may forward to /images; everything else
 * (`prompt`, `model`, `output_path`, …) is tool-internal. */
export const FORWARDABLE_PARAMS = [
    'resolution',
    'aspect_ratio',
    'n',
    'seed',
    'size',
    'quality',
    'output_format',
    'background',
    'output_compression',
] as const;

export type ForwardableParam = (typeof FORWARDABLE_PARAMS)[number];

/** Capability cache over one shared /images/models listing. */
export class CapabilityCache {
    private records = new Map<string, ImageModelRecord>();
    private loadedAt = 0;
    private inflight: Promise<void> | undefined;
    private readonly base: Omit<ClientBase, 'signal'>;
    private readonly ttlMs: number;
    private readonly now: () => number;

    constructor(opts: { baseURL: string; apiKey?: string; ttlMs: number; fetchImpl?: typeof fetch; now?: () => number }) {
        this.base = { baseURL: opts.baseURL, apiKey: opts.apiKey, fetchImpl: opts.fetchImpl };
        this.ttlMs = opts.ttlMs;
        this.now = opts.now ?? Date.now;
    }

    /** Whether at least one listing has been loaded (i.e. records are facts, not guesses). */
    get hasRecord(): boolean {
        return this.loadedAt > 0;
    }

    /** Record for one model, loading/refreshing the listing when the TTL expired.
     * Returns `undefined` when the model is unknown to OpenRouter or the listing
     * cannot be fetched (the caller then skips the gate instead of blocking). */
    async get(modelId: string, signal?: AbortSignal): Promise<ImageModelRecord | undefined> {
        const fresh = this.loadedAt > 0 && this.now() - this.loadedAt < this.ttlMs;
        if (!fresh && !this.inflight) {
            this.inflight = this.load(signal).finally(() => {
                this.inflight = undefined;
            });
        }
        if (this.inflight) {
            try {
                await this.inflight;
            } catch {
                // Contained: an unavailable listing leaves the previous records in place.
            }
        }
        return this.records.get(modelId);
    }

    /** Drop all records so the next `get` refetches. */
    invalidate(): void {
        this.records.clear();
        this.loadedAt = 0;
    }

    private async load(signal?: AbortSignal): Promise<void> {
        const list = await fetchImageModels({ ...this.base, signal });
        this.records = new Map(list.map((m) => [m.id, m]));
        this.loadedAt = this.now();
    }
}

export interface GateInput {
    /** Validated tool-call arguments (may name forwardable parameters). */
    call: Record<string, unknown>;
    /** Configured defaults for the alias. */
    defaults: Record<string, unknown>;
    /** The model's capability record; `undefined` skips value checks (unknown capabilities). */
    descriptor?: Record<string, CapabilityDescriptor>;
    /** Whether `descriptor` is a loaded fact (false when the listing was unavailable). */
    descriptorKnown: boolean;
    alias: string;
    modelId: string;
}

export interface GateOutcome {
    /** Parameters to send in the /images body. */
    params: Record<string, JsonValue>;
    /** Config default keys silently dropped because the model lacks them. */
    droppedDefaults: string[];
}

function violationOf(desc: CapabilityDescriptor, value: unknown): string | undefined {
    switch (desc.type) {
        case 'enum':
            return typeof value === 'string' && desc.values.includes(value)
                ? undefined
                : `value ${JSON.stringify(value)} is not one of ${desc.values.map((v) => JSON.stringify(v)).join(', ')}`;
        case 'range':
            return Number.isInteger(value) && (value as number) >= desc.min && (value as number) <= desc.max
                ? undefined
                : `value ${JSON.stringify(value)} is not an integer within [${desc.min}, ${desc.max}]`;
        case 'boolean':
            return typeof value === 'boolean' ? undefined : `value ${JSON.stringify(value)} is not a boolean`;
    }
}

/** Where a reference list came from, for error attribution. */
export type ParamOrigin = 'call' | 'default';

export interface ReferenceGateInput {
    /** How many reference images the call (or the alias default) named. */
    count: number;
    descriptor?: Record<string, CapabilityDescriptor>;
    /** Whether `descriptor` is a loaded fact (false when the listing was unavailable). */
    descriptorKnown: boolean;
    origin: ParamOrigin;
    alias: string;
    modelId: string;
}

/**
 * Gate the reference-image list.
 *
 * `input_references` needs its own gate because its descriptor is a `range`
 * over the COUNT, not over a value: `{ type: 'range', min: 0, max: 14 }` means
 * "up to fourteen images", so the generic value check in `buildParams` would
 * test the array itself against an integer range and reject every call.
 *
 * The two error classes are the ones the rest of the gate uses — a call-named
 * capability the model lacks is an error, an unsupported config default is
 * dropped — so nothing new has to be learned to predict this one.
 * @param input - the count, the model's record, and where the list came from.
 * @returns `'send'` to forward the references, `'drop'` to omit them.
 * @throws when a call named references the model cannot honor.
 */
export function gateReferences(input: ReferenceGateInput): 'send' | 'drop' {
    if (input.count === 0) return 'drop';
    const desc = input.descriptor?.input_references;
    if (!desc) {
        // Unknown capabilities (listing unavailable): forward without gate.
        if (!input.descriptorKnown) return 'send';
        if (input.origin === 'call') {
            throw new Error(
                `Model ${input.modelId} does not support reference images `
                + `(no "input_references" in its capability record). `
                + `Supported parameters: ${Object.keys(input.descriptor ?? {}).join(', ') || '(none)'}.`,
            );
        }
        return 'drop';
    }
    if (desc.type !== 'range') return 'send';
    if (input.count >= desc.min && input.count <= desc.max) return 'send';
    if (input.origin === 'call') {
        throw new Error(
            `Invalid "input_references" for model ${input.modelId}: ${input.count} reference images, `
            + `but the model accepts ${desc.min} to ${desc.max}.`,
        );
    }
    throw new Error(
        `Configuration error: imagegen.models.${input.alias}.defaults.input_references names `
        + `${input.count} reference images, but ${input.modelId} accepts ${desc.min} to ${desc.max}. `
        + `Fix the defaults for this alias.`,
    );
}

/** Assemble the gated request parameters per the design's resolution order
 * (call argument → alias defaults → omit) and error classes. Throws with an
 * actionable message naming parameter, origin, and model. */
export function buildParams(input: GateInput): GateOutcome {
    const params: Record<string, JsonValue> = {};
    const droppedDefaults: string[] = [];
    for (const key of FORWARDABLE_PARAMS) {
        const fromCall = input.call[key] !== undefined;
        const fromDefault = !fromCall && input.defaults[key] !== undefined;
        if (!fromCall && !fromDefault) continue;
        const origin: 'call' | 'default' = fromCall ? 'call' : 'default';
        const value = fromCall ? input.call[key] : input.defaults[key];
        const desc = input.descriptor?.[key];
        if (!desc) {
            if (input.descriptorKnown) {
                // A loaded record without the key means: this model does not support it.
                if (origin === 'call') {
                    throw new Error(
                        `Model ${input.modelId} does not support the "${key}" parameter. `
                        + `Supported parameters: ${Object.keys(input.descriptor ?? {}).join(', ') || '(none)'}.`,
                    );
                }
                droppedDefaults.push(key);
                continue;
            }
            // Unknown capabilities (listing unavailable): forward without gate.
            params[key] = value as JsonValue;
            continue;
        }
        const violation = violationOf(desc, value);
        if (violation) {
            if (origin === 'call') {
                throw new Error(
                    `Invalid "${key}" for model ${input.modelId}: ${violation}.`,
                );
            }
            throw new Error(
                `Configuration error: imagegen.models.${input.alias}.defaults.${key} = ${JSON.stringify(value)} `
                + `violates the capability record of ${input.modelId} (${violation}). Fix the defaults for this alias.`,
            );
        }
        params[key] = value as JsonValue;
    }
    if (params.n !== undefined) params.n = Number(params.n);
    return { params, droppedDefaults };
}
