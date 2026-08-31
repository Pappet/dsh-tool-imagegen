/**
 * dsh-tool-imagegen tests — no harness, no network: fetch is faked,
 * the plugin context is a minimal stub, files land in a temp dir.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extForMediaType, sanitizeName, timestampForName, withMediaExtension, writeImages } from '../lib/write.js';
import { readReferences, sniffMediaType, toWireReference } from '../lib/references.js';
import { isUsableSettings, settingsFromConfig, validateSettings } from '../lib/settings.js';
import { CapabilityCache, buildParams, gateReferences, FORWARDABLE_PARAMS } from '../lib/capabilities.js';
import { OpenRouterHttpError, fetchImageModels, generateImage } from '../lib/openrouter.js';
import { applyWithDeps as apply } from '../lib/index.js';
import { chatSummary } from '../lib/chat.js';

const SEEDREAM_RECORD = {
    id: 'bytedance-seed/seedream-4.5',
    supported_parameters: {
        resolution: { type: 'enum', values: ['1K', '2K', '4K'] },
        aspect_ratio: { type: 'enum', values: ['1:1', '16:9', '9:16'] },
        n: { type: 'range', min: 1, max: 10 },
        seed: { type: 'boolean' },
    },
    supports_streaming: false,
};

const PNG_B64 = Buffer.from('png-bytes-1').toString('base64');
const JPG_B64 = Buffer.from('jpg-bytes-22').toString('base64');

function okRes(body) {
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
}

// ---------------------------------------------------------------- write.ts

test('extForMediaType maps known types and defaults to png', () => {
    assert.equal(extForMediaType('image/png'), 'png');
    assert.equal(extForMediaType('image/jpeg'), 'jpg');
    assert.equal(extForMediaType('image/webp'), 'webp');
    assert.equal(extForMediaType('image/svg+xml'), 'svg');
    assert.equal(extForMediaType(undefined), 'png');
    assert.equal(extForMediaType('image/x-unknown'), 'png');
});

test('sanitizeName keeps filenames safe', () => {
    assert.equal(sanitizeName('bytedance-seed/seedream 4.5'), 'bytedance-seed-seedream-4.5');
    assert.equal(sanitizeName('***'), 'image');
});

test('timestampForName has the YYYYMMDD-HHmmss shape', () => {
    assert.match(timestampForName(new Date('2026-08-17T14:15:30')), /^\d{8}-\d{6}$/);
});

test('writeImages: default naming carries the 1-based index and falls back to png', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imagegen-'));
    try {
        const written = await writeImages({
            images: [{ b64: PNG_B64 }, { b64: JPG_B64, mediaType: 'image/jpeg' }],
            dir, baseName: 'seedream-20260817-141530', workspaceRoot: dir,
        });
        assert.deepEqual(written.map((w) => w.mediaType), ['image/png', 'image/jpeg']);
        assert.match(written[0].path, /seedream-20260817-141530-1\.png$/);
        assert.match(written[1].path, /seedream-20260817-141530-2\.jpg$/);
        assert.equal(written[0].bytes, Buffer.from(PNG_B64, 'base64').byteLength);
        assert.equal((await readFile(written[0].path)).toString(), 'png-bytes-1');
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('writeImages: output_path overrides the first image; n > 1 inserts the index before the ext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imagegen-'));
    try {
        const out = join(dir, 'my-image.png');
        const written = await writeImages({
            images: [{ b64: PNG_B64 }, { b64: PNG_B64 }, { b64: PNG_B64 }],
            dir, baseName: 'seedream-ts', outputPath: out, workspaceRoot: dir,
        });
        assert.equal(written[0].path, out);
        assert.match(written[1].path, /my-image-2\.png$/);
        assert.match(written[2].path, /my-image-3\.png$/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('writeImages: collision bumps the -N suffix, already-written images are not removed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imagegen-'));
    try {
        const out = join(dir, 'my-image.png');
        await writeFile(out, 'existing');
        const written = await writeImages({
            images: [{ b64: PNG_B64 }, { b64: PNG_B64 }],
            dir, baseName: 'seedream-ts', outputPath: out, workspaceRoot: dir,
        });
        assert.match(written[0].path, /my-image-2\.png$/);
        assert.match(written[1].path, /my-image-3\.png$/);
        assert.equal(await readFile(out, 'utf8'), 'existing');
        const s = await stat(written[0].path);
        assert.ok(s.isFile());
    } finally { await rm(dir, { recursive: true, force: true }); }
});

// -------------------------------------------------------- capabilities.ts

const GATE_BASE = {
    call: {}, defaults: {}, descriptor: SEEDREAM_RECORD.supported_parameters,
    descriptorKnown: true, alias: 'seedream', modelId: SEEDREAM_RECORD.id,
};

test('gate: call argument wins over default; both applied', () => {
    const out = buildParams({ ...GATE_BASE, defaults: { resolution: '2K', aspect_ratio: '16:9' }, call: { resolution: '4K' } });
    assert.deepEqual(out.params, { resolution: '4K', aspect_ratio: '16:9' });
    assert.deepEqual(out.droppedDefaults, []);
});

test('gate: call-named unsupported parameter is an ERROR naming parameter and model', () => {
    assert.throws(
        () => buildParams({ ...GATE_BASE, call: { quality: 'high' } }),
        /seedream-4\.5 does not support the "quality" parameter/,
    );
});

test('gate: call-named out-of-range value is an ERROR listing allowed values', () => {
    assert.throws(
        () => buildParams({ ...GATE_BASE, call: { resolution: '8K' } }),
        /Invalid "resolution".*not one of "1K", "2K", "4K"/,
    );
    assert.throws(
        () => buildParams({ ...GATE_BASE, call: { n: 50 } }),
        /Invalid "n".*\[1, 10\]/,
    );
});

test('gate: unsupported default is silently dropped and reported', () => {
    const out = buildParams({ ...GATE_BASE, defaults: { quality: 'high', resolution: '2K' } });
    assert.deepEqual(out.params, { resolution: '2K' });
    assert.deepEqual(out.droppedDefaults, ['quality']);
});

test('gate: out-of-range default fails closed with a config-attributed error', () => {
    assert.throws(
        () => buildParams({ ...GATE_BASE, defaults: { resolution: '8K' } }),
        /Configuration error: imagegen\.models\.seedream\.defaults\.resolution/,
    );
});

test('gate: unknown capabilities forward without gate', () => {
    const out = buildParams({ ...GATE_BASE, descriptor: undefined, descriptorKnown: false, call: { resolution: 'whatever', quality: 7 } });
    assert.deepEqual(out.params, { resolution: 'whatever', quality: 7 });
});

test('gate: non-forwardable keys never reach the request', () => {
    const out = buildParams({ ...GATE_BASE, call: { prompt: 'x', model: 'y', output_path: 'z', seed: true } });
    assert.deepEqual(out.params, { seed: true });
    assert.ok(FORWARDABLE_PARAMS.includes('resolution'));
});

test('CapabilityCache: loads, caches within TTL, invalidates, survives fetch errors', async () => {
    let calls = 0;
    const impl = async () => { calls += 1; return okRes({ data: [SEEDREAM_RECORD] }); };
    let clock = 1000;
    const cache = new CapabilityCache({ baseURL: 'https://x/api/v1', ttlMs: 10_000, fetchImpl: impl, now: () => clock });
    assert.equal((await cache.get(SEEDREAM_RECORD.id))?.id, SEEDREAM_RECORD.id);
    assert.equal((await cache.get(SEEDREAM_RECORD.id))?.id, SEEDREAM_RECORD.id);
    assert.equal(calls, 1, 'second get within TTL must not refetch');
    assert.ok(cache.hasRecord);

    clock = 20_000; // TTL expired
    await cache.get(SEEDREAM_RECORD.id);
    assert.equal(calls, 2, 'expired TTL refetches');

    cache.invalidate();
    assert.ok(!cache.hasRecord);
    // fetch now failing: get stays contained and returns undefined
    const failing = async () => { throw new OpenRouterHttpError(500, 'boom', 'u'); };
    const cache2 = new CapabilityCache({ baseURL: 'https://x/api/v1', ttlMs: 0, fetchImpl: failing });
    assert.equal(await cache2.get(SEEDREAM_RECORD.id), undefined);
});

// ---------------------------------------------------------- openrouter.ts

test('fetchImageModels: returns the data array and reports status AND body on HTTP errors', async () => {
    const impl = async () => okRes({ data: [SEEDREAM_RECORD] });
    const models = await fetchImageModels({ baseURL: 'https://x/api/v1', fetchImpl: impl });
    assert.deepEqual(models, [SEEDREAM_RECORD]);

    const err404 = { ok: false, status: 404, text: async () => '{"error":"Not found"}' };
    await assert.rejects(
        fetchImageModels({ baseURL: 'https://x/api/v1', fetchImpl: async () => err404 }),
        (e) => e instanceof OpenRouterHttpError && e.status === 404 && e.body.includes('Not found'),
    );
});

test('generateImage: maps data and usage.cost; throws on empty data; sends model+prompt+params', async () => {
    let captured;
    const impl = async (url, init) => {
        captured = { url, init };
        return okRes({ created: 1, data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.04 } });
    };
    const gen = await generateImage({
        baseURL: 'https://x/api/v1', apiKey: 'k', model: 'bytedance-seed/seedream-4.5', prompt: 'a cat',
        params: { resolution: '2K' }, fetchImpl: impl,
    });
    assert.equal(gen.costUsd, 0.04);
    assert.deepEqual(gen.images, [{ b64: PNG_B64, mediaType: 'image/png' }]);
    assert.equal(captured.url, 'https://x/api/v1/images');
    const body = JSON.parse(captured.init.body);
    assert.deepEqual(body, { model: 'bytedance-seed/seedream-4.5', prompt: 'a cat', resolution: '2K' });
    assert.equal(captured.init.headers.Authorization, 'Bearer k');

    const empty = async () => okRes({ data: [] });
    await assert.rejects(generateImage({ baseURL: 'b', model: 'm', prompt: 'p', params: {}, fetchImpl: empty }), /no image data/);

    const bad = async () => okRes({ data: [{ nope: true }] });
    await assert.rejects(generateImage({ baseURL: 'b', model: 'm', prompt: 'p', params: {}, fetchImpl: bad }), /no b64_json/);
});

// -------------------------------------------------------------- index.ts

function fakeCtx(credentialsSeam, attachmentsSeam, settingsSeam) {
    const registered = [];
    const effects = [];
    return {
        registered,
        // Real cordis runs an effect's setup immediately; the fake defers so a
        // test decides whether the boot-time capability prefetch runs.
        runEffects: () => effects.forEach((fn) => fn()),
        ctx: {
            tools: { register: (def) => registered.push(def) },
            effect: (fn) => effects.push(fn),
            credentials: credentialsSeam ?? { resolve: async () => undefined },
            get: (name) => (name === 'attachments' ? attachmentsSeam : undefined),
            inject: (names, cb) => {
                if (names.includes('settings') && settingsSeam) cb({ settings: settingsSeam });
            },
        },
    };
}

function fakeSettings(initial) {
    const state = { registered: undefined, watchers: [], value: initial };
    return {
        state,
        register: (ns, schema, options) => {
            state.registered = { ns: String(ns), schema, options };
            if (state.value === undefined) state.value = options?.base;
            return {
                get: () => state.value,
                watch: (cb) => { state.watchers.push(cb); return () => { state.watchers = []; }; },
            };
        },
        emit: (next) => {
            const prev = state.value;
            state.value = next;
            for (const w of state.watchers) w(next, prev);
        },
    };
}

function fakeExec() {
    const deferred = [];
    return { exec: { signal: new AbortController().signal, deferContext: (m) => deferred.push(m) }, deferred };
}

function fakeAttachmentStore() {
    const saved = [];
    let fail = false;
    return {
        saved,
        setFail: () => { fail = true; },
        saveImage: async (input) => {
            if (fail) throw new Error('attachment store down');
            saved.push(input);
            return {
                attachmentId: `att-${saved.length}`,
                mediaType: input.mediaType,
                bytes: input.data.byteLength,
                width: 100,
                height: 100,
                name: input.name,
            };
        },
    };
}

const CONFIG = {
    apiKeyEnv: 'IMAGEGEN_TEST_KEY',
    baseURL: 'https://openrouter.test/api/v1',
    outputDir: '.dsh/images',
    defaultModel: 'seedream',
    capabilityTtlMs: 60_000,
    maxImagesPerCall: 4,
    models: {
        seedream: { id: 'bytedance-seed/seedream-4.5', defaults: { resolution: '2K', aspect_ratio: '16:9' } },
        pro: { id: 'bytedance-seed/seedream-5-0-pro' },
    },
};

function setupTool(fetchImpl) {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const { ctx, registered } = fakeCtx();
    apply(ctx, CONFIG);
    assert.equal(registered.length, 1);
    const tool = registered[0];
    assert.equal(tool.name, 'generate_image');
    return { tool, calls: [], setFetch: () => { /* via closure below */ } };
}

test('plugin: registers exactly one generate_image tool with presenters and meta', () => {
    const { tool } = setupTool();
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.presentCall, 'function');
    assert.equal(typeof tool.presentResult, 'function');
    const callView = tool.presentCall({ prompt: 'A red bicycle'.padEnd(300, ' x') });
    assert.equal(callView.card, 'generic');
    assert.equal(callView.kind, 'other');
    assert.equal(callView.locations, undefined);
    assert.ok(callView.content[0].text.length <= 201 + 1);
    // a named output_path declares the mutation intent (deliverables chips)
    const namedView = tool.presentCall({ prompt: 'x', output_path: 'bilder/pic.png' });
    assert.equal(namedView.kind, 'edit');
    assert.deepEqual(namedView.locations, [{ path: 'bilder/pic.png' }]);
    const meta = { model: 'm', alias: 'a', images: [{ path: '/p/1.png', mediaType: 'image/png' }] };
    // presenters soft-validate args (replay safety): invalid args fall back to undefined
    assert.equal(tool.presentResult({}, { isError: false, content: [], meta }), undefined);
    const resultView = tool.presentResult({ prompt: 'x' }, { isError: false, content: [], meta });
    assert.equal(resultView.card, 'generic');
    assert.match(resultView.title, /Bild generiert/);
    assert.deepEqual(resultView.content.map((c) => c.text), ['/p/1.png']);
    assert.equal(tool.presentResult({ prompt: 'x' }, { isError: true, content: [] }), undefined);
});

test('plugin: happy path — canonical value, gate applied, files written', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    let postBody;
    const fetchImpl = async (url, init = {}) => {
        if (String(url).endsWith('/images/models')) return okRes({ data: [SEEDREAM_RECORD] });
        postBody = JSON.parse(init.body);
        return okRes({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.04 } });
    };
    const { ctx, registered } = fakeCtx();
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-ws-'));
    try {
        const config = { ...CONFIG, outputDir: 'images', baseURL: 'https://openrouter.test/api/v1' };
        apply(ctx, config, { fetchImpl, workspaceRoot: workspace });
        const tool = registered[0];
        const value = await tool.execute(
            { prompt: 'a lighthouse' },
            { signal: new AbortController().signal },
        );
        assert.equal(value.model, 'bytedance-seed/seedream-4.5');
        assert.equal(value.alias, 'seedream');
        assert.equal(value.costUsd, 0.04);
        assert.match(value.images[0].path, new RegExp(`^${workspace}/images/seedream-\\d{8}-\\d{6}-1\\.png$`));
        assert.deepEqual(value.applied, { resolution: '2K', aspect_ratio: '16:9' });
        assert.deepEqual(value.droppedDefaults, []);
        assert.deepEqual(postBody, {
            model: 'bytedance-seed/seedream-4.5', prompt: 'a lighthouse', resolution: '2K', aspect_ratio: '16:9',
        });
        // render + meta are pure functions of the value
        const blocks = tool.output.render({}, value);
        assert.match(blocks[0].text, /Generated 1 image\(s\) with bytedance-seed\/seedream-4\.5 \(0\.0400 USD\)/);
        assert.deepEqual(tool.output.presentationMeta({}, value).images, [{ path: value.images[0].path, mediaType: 'image/png' }]);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('plugin: hand checks — empty prompt, bad n, over-cap n, unknown alias, missing key', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const { ctx, registered } = fakeCtx();
    apply(ctx, CONFIG);
    const tool = registered[0];
    const exec = { signal: new AbortController().signal };
    await assert.rejects(tool.execute({ prompt: '   ' }, exec), /non-empty "prompt"/);
    await assert.rejects(tool.execute({ prompt: 'x', n: 0 }, exec), /integer >= 1/);
    await assert.rejects(tool.execute({ prompt: 'x', n: 5 }, exec), /exceeds the configured maxImagesPerCall = 4/);
    await assert.rejects(tool.execute({ prompt: 'x', model: 'flux' }, exec), /Unknown model alias "flux".*seedream, pro/);
    delete process.env.IMAGEGEN_TEST_KEY;
    await assert.rejects(tool.execute({ prompt: 'x' }, exec), /no dsh credential "IMAGEGEN_TEST_KEY" and no environment variable/);
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
});

test('plugin: gate errors surface as thrown errors (isError) with repairable detail', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const fetchImpl = async (url) => {
        if (String(url).endsWith('/images/models')) return okRes({ data: [SEEDREAM_RECORD] });
        throw new Error('must not be called');
    };
    const { ctx, registered } = fakeCtx();
    apply(ctx, CONFIG, { fetchImpl });
    const tool = registered[0];
    await assert.rejects(
        tool.execute({ prompt: 'x', resolution: '8K' }, { signal: new AbortController().signal }),
        (e) => /Invalid "resolution".*not one of/.test(e.message),
    );
});

test('plugin: stale-capability 400 is retried once after invalidation', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    let modelFetches = 0;
    let posts = 0;
    const fetchImpl = async (url, init = {}) => {
        if (String(url).endsWith('/images/models')) {
            modelFetches += 1;
            // First listing: no seed param. After invalidation: seed supported.
            const rec = modelFetches === 1
                ? { ...SEEDREAM_RECORD, supported_parameters: { ...SEEDREAM_RECORD.supported_parameters, seed: undefined } }
                : SEEDREAM_RECORD;
            const { seed, ...rest } = rec.supported_parameters;
            return okRes({ data: [{ ...rec, supported_parameters: modelFetches === 1 ? rest : SEEDREAM_RECORD.supported_parameters }] });
        }
        posts += 1;
        if (posts === 1) return { ok: false, status: 400, text: async () => '{"error":"seed not supported"}' };
        return okRes({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.04 } });
    };
    const { ctx, registered } = fakeCtx();
    // A workspace root is mandatory for every test that reaches the WRITE step:
    // without it the images land in process.cwd(), i.e. in this repository.
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-retry-'));
    try {
        apply(ctx, CONFIG, { fetchImpl, workspaceRoot: workspace });
        const tool = registered[0];
        const value = await tool.execute(
            { prompt: 'x', model: 'pro', seed: 42 },
            { signal: new AbortController().signal },
        );
        assert.equal(modelFetches, 2, 'listing refetched after the 400');
        assert.equal(posts, 2);
        assert.equal(value.applied.seed, 42);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('plugin: API key resolves through the credentials seam, env as fallback', async () => {
    const seenRefs = [];
    const seamKey = 'seam-key';
    const fetchImpl = async (url, init = {}) => {
        if (String(url).endsWith('/images/models')) return okRes({ data: [SEEDREAM_RECORD] });
        return okRes({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.04 } });
    };
    // capture the Authorization header the client actually sent
    let auth;
    const captureFetch = async (url, init = {}) => {
        const res = await fetchImpl(url, init);
        if (String(url).endsWith('/images')) auth = init.headers?.Authorization;
        return res;
    };
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-key-'));
    try {
        // 1. Seam wins over env.
        delete process.env.IMAGEGEN_TEST_KEY;
        const seam = { resolve: async (ref) => { seenRefs.push(ref); return { value: seamKey, source: 'file' }; } };
        let { ctx, registered } = fakeCtx(seam);
        apply(ctx, { ...CONFIG, outputDir: 'k1' }, { fetchImpl: captureFetch, workspaceRoot: workspace });
        await registered[0].execute({ prompt: 'x' }, { signal: new AbortController().signal });
        assert.equal(auth, `Bearer ${seamKey}`, 'seam value must reach the Authorization header');
        assert.equal(seenRefs.length, 1, 'credentialRef was resolved exactly once');

        // 2. Empty seam value → env fallback.
        process.env.IMAGEGEN_TEST_KEY = 'env-key';
        ({ ctx, registered } = fakeCtx({ resolve: async () => undefined }));
        apply(ctx, { ...CONFIG, outputDir: 'k2' }, { fetchImpl: captureFetch, workspaceRoot: workspace });
        await registered[0].execute({ prompt: 'x' }, { signal: new AbortController().signal });
        assert.equal(auth, 'Bearer env-key');

        // 3. Throwing seam → env fallback (contained).
        ({ ctx, registered } = fakeCtx({ resolve: async () => { throw new Error('seam down'); } }));
        apply(ctx, { ...CONFIG, outputDir: 'k3' }, { fetchImpl: captureFetch, workspaceRoot: workspace });
        await registered[0].execute({ prompt: 'x' }, { signal: new AbortController().signal });
        assert.equal(auth, 'Bearer env-key');

        // 4. Both missing → actionable error naming both channels.
        delete process.env.IMAGEGEN_TEST_KEY;
        ({ ctx, registered } = fakeCtx({ resolve: async () => undefined }));
        apply(ctx, CONFIG, { fetchImpl, workspaceRoot: workspace });
        await assert.rejects(
            registered[0].execute({ prompt: 'x' }, { signal: new AbortController().signal }),
            /no dsh credential "IMAGEGEN_TEST_KEY".*\.credentials\.yaml/,
        );
    } finally {
        delete process.env.IMAGEGEN_TEST_KEY;
        await rm(workspace, { recursive: true, force: true });
    }
});

// ------------------------------------------------------- chat display (3b)

const ChatFetch = () => async (url, init = {}) => {
    if (String(url).endsWith('/images/models')) return okRes({ data: [SEEDREAM_RECORD] });
    return okRes({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.04 } });
};

test('chat: generated image is attached and deferred as a plugin message', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const store = fakeAttachmentStore();
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-chat-'));
    try {
        const { ctx, registered } = fakeCtx(undefined, store);
        apply(ctx, { ...CONFIG, outputDir: 'c1' }, { fetchImpl: ChatFetch(), workspaceRoot: workspace });
        const { exec, deferred } = fakeExec();
        const value = await registered[0].execute({ prompt: 'x' }, exec);
        assert.equal(store.saved.length, 1);
        assert.equal(store.saved[0].mediaType, 'image/png');
        assert.match(store.saved[0].name, /\.png$/);
        assert.equal(deferred.length, 1, 'one plugin message deferred');
        const msg = deferred[0];
        assert.equal(msg.role, 'user');
        assert.equal(msg.source.kind, 'plugin');
        assert.equal(msg.source.plugin, 'dsh-tool-imagegen');
        // `notice` form: the collapsed context row reads the summary instead of
        // falling back to the plugin name beside an unpresentable image block.
        assert.equal(msg.source.form, 'notice');
        assert.equal(msg.source.summary, `Bild erzeugt: ${value.images[0].path}`);
        assert.equal(msg.content[0].type, 'image');
        assert.equal(msg.content[0].attachment.attachmentId, 'att-1');
        assert.equal(msg.content[1].type, 'text');
        assert.ok(msg.content[1].text.includes(value.images[0].path));
        // canonical value carries the durable refs
        assert.equal(value.attachments.length, 1);
        assert.equal(value.attachments[0].attachmentId, 'att-1');
        assert.equal(value.attachments[0].width, 100);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('chat: non-attachable media (SVG) skips attachment, path-only result stays intact', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const svgFetch = async (url) => {
        if (String(url).endsWith('/images/models')) return okRes({ data: [SEEDREAM_RECORD] });
        return okRes({ data: [{ b64_json: PNG_B64, media_type: 'image/svg+xml' }], usage: { cost: 0.04 } });
    };
    const store = fakeAttachmentStore();
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-svg-'));
    try {
        const { ctx, registered } = fakeCtx(undefined, store);
        apply(ctx, { ...CONFIG, outputDir: 'c2' }, { fetchImpl: svgFetch, workspaceRoot: workspace });
        const { exec, deferred } = fakeExec();
        const value = await registered[0].execute({ prompt: 'x' }, exec);
        assert.equal(store.saved.length, 0);
        assert.equal(deferred.length, 0);
        assert.equal(value.attachments, undefined);
        assert.match(value.images[0].path, /\.svg$/);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('chat: attachment store failure is contained — generation still succeeds', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const store = fakeAttachmentStore();
    store.setFail();
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-fail-'));
    try {
        const { ctx, registered } = fakeCtx(undefined, store);
        apply(ctx, { ...CONFIG, outputDir: 'c3' }, { fetchImpl: ChatFetch(), workspaceRoot: workspace });
        const { exec, deferred } = fakeExec();
        const value = await registered[0].execute({ prompt: 'x' }, exec);
        assert.equal(value.images.length, 1);
        assert.ok(value.images[0].path.length > 0);
        assert.equal(deferred.length, 0);
        assert.equal(value.attachments, undefined);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('chat: showInChat false skips the attachment store entirely', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const store = fakeAttachmentStore();
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-off-'));
    try {
        const { ctx, registered } = fakeCtx(undefined, store);
        apply(ctx, { ...CONFIG, outputDir: 'c4', showInChat: false }, { fetchImpl: ChatFetch(), workspaceRoot: workspace });
        const { exec, deferred } = fakeExec();
        const value = await registered[0].execute({ prompt: 'x' }, exec);
        assert.equal(store.saved.length, 0);
        assert.equal(deferred.length, 0);
        assert.equal(value.attachments, undefined);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

// --------------------------------------------- schema projection + session cwd

test('chat: store refs are projected onto the declared schema fields', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const store = fakeAttachmentStore();
    // the real store may add metadata beyond the declared shape
    const origSave = store.saveImage.bind(store);
    store.saveImage = async (input) => ({
        ...(await origSave(input)),
        originalDimensions: { width: 4096, height: 4096 },
        someFutureField: 'must-not-leak',
    });
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-proj-'));
    try {
        const { ctx, registered } = fakeCtx(undefined, store);
        apply(ctx, { ...CONFIG, outputDir: 'p1' }, { fetchImpl: ChatFetch(), workspaceRoot: workspace });
        const { exec, deferred } = fakeExec();
        const value = await registered[0].execute({ prompt: 'x' }, exec);
        const ref = value.attachments[0];
        assert.deepEqual(Object.keys(ref).sort(), [
            'attachmentId', 'bytes', 'height', 'mediaType', 'name', 'originalDimensions', 'width',
        ]);
        assert.deepEqual(ref.originalDimensions, { width: 4096, height: 4096 });
        // the deferred message keeps the FULL ref (store truth)
        assert.equal(deferred[0].content[0].attachment.someFutureField, 'must-not-leak');
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('workspace: relative paths resolve against the session cwd, not process.cwd()', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-cwd-'));
    try {
        const { ctx, registered } = fakeCtx();
        apply(ctx, { ...CONFIG, outputDir: 'from-session' }, { fetchImpl: ChatFetch() });
        const exec = {
            signal: new AbortController().signal,
            agent: { session: { header: { cwd: workspace } } },
        };
        const value = await registered[0].execute({ prompt: 'x', output_path: 'docs/pic.png' }, exec);
        assert.equal(value.images[0].path, `${workspace}/docs/pic.png`);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('manifest: the client bundle is declared at dsh.client (where the harness reads it)', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    // dsh-client-modules resolveMeta() reads pkg.dsh.client — a manifest nested
    // under dsh.bundle is never discovered, so the tool card never loads.
    assert.equal(pkg.dsh?.client?.platform, 'web');
    assert.equal(pkg.dsh?.bundle?.client, undefined);
    // ...and it must export "./client", which resolveMeta() requires alongside it.
    assert.ok(pkg.exports?.['./client']);
});

test('chat: the notice summary names every path and stays inside the 120-char bound', async () => {
    const path = (n) => `/w/${'x'.repeat(40)}/${n}.png`;
    const one = chatSummary([{ ref: {}, path: '/w/a.png' }]);
    assert.equal(one, 'Bild erzeugt: /w/a.png');
    const many = chatSummary([1, 2, 3].map((n) => ({ ref: {}, path: path(n) })));
    assert.ok(many.startsWith('3 Bilder erzeugt: '));
    assert.ok(many.length <= 120, `summary is ${many.length} chars`);
});

// ------------------------------------------- write.ts: extension vs. bytes

test('withMediaExtension corrects an extension that contradicts the bytes', () => {
    // The generation API decides the encoding; `output_path` only names the file.
    // A .png holding JPEG bytes is what shipped before this was gated.
    assert.equal(withMediaExtension('/a/pic.png', 'image/jpeg'), '/a/pic.jpg');
    assert.equal(withMediaExtension('/a/pic.webp', 'image/png'), '/a/pic.png');
    // An alternate spelling of the SAME type is left alone.
    assert.equal(withMediaExtension('/a/pic.jpeg', 'image/jpeg'), '/a/pic.jpeg');
    assert.equal(withMediaExtension('/a/pic.JPG', 'image/jpeg'), '/a/pic.JPG');
    // Agreement, and the no-extension case.
    assert.equal(withMediaExtension('/a/pic.png', 'image/png'), '/a/pic.png');
    assert.equal(withMediaExtension('/a/pic', 'image/png'), '/a/pic.png');
    assert.equal(withMediaExtension('/a/v1.2/pic', 'image/png'), '/a/v1.2/pic.png');
    // Nothing known about the bytes → the caller's path is not second-guessed.
    assert.equal(withMediaExtension('/a/pic.jpg', undefined), '/a/pic.jpg');
    assert.equal(withMediaExtension('/a/pic.jpg', 'image/x-unknown'), '/a/pic.jpg');
});

test('writeImages: output_path keeps its name but never lies about the encoding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imagegen-ext-'));
    try {
        const written = await writeImages({
            images: [{ b64: JPG_B64, mediaType: 'image/jpeg' }],
            dir, baseName: 'seedream-ts', outputPath: join(dir, 'bibi-und-tina.png'), workspaceRoot: dir,
        });
        assert.equal(written[0].path, join(dir, 'bibi-und-tina.jpg'));
        assert.equal(written[0].mediaType, 'image/jpeg');
        assert.equal((await readFile(written[0].path)).toString(), 'jpg-bytes-22');
    } finally { await rm(dir, { recursive: true, force: true }); }
});

// -------------------------------------------------------- references.ts

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);
const GIF_BYTES = Buffer.from('GIF89a-rest');
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPrest')]);

const REF_LIMITS = { maxBytes: 1024, maxTotalBytes: 4096 };

test('sniffMediaType reads the magic bytes, not the file name', () => {
    assert.equal(sniffMediaType(PNG_BYTES), 'image/png');
    assert.equal(sniffMediaType(JPG_BYTES), 'image/jpeg');
    assert.equal(sniffMediaType(GIF_BYTES), 'image/gif');
    assert.equal(sniffMediaType(WEBP_BYTES), 'image/webp');
    assert.equal(sniffMediaType(Buffer.from('<svg/>')), undefined);
    assert.equal(sniffMediaType(Buffer.alloc(2)), undefined);
});

test('references: http(s) values pass through untouched and never hit the disk', async () => {
    const refs = await readReferences({
        values: ['https://example.test/a.jpg', 'http://example.test/b.png'],
        workspaceRoot: '/nonexistent', ...REF_LIMITS,
    });
    assert.deepEqual(refs.map((r) => r.url), ['https://example.test/a.jpg', 'http://example.test/b.png']);
    assert.deepEqual(refs.map((r) => r.bytes), [undefined, undefined]);
    assert.deepEqual(toWireReference(refs[0]), {
        type: 'image_url', image_url: { url: 'https://example.test/a.jpg' },
    });
});

test('references: paths resolve against the workspace root and carry the SNIFFED type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imagegen-ref-'));
    try {
        // The file lies with its extension — exactly what this tool used to write.
        await writeFile(join(dir, 'ref.png'), JPG_BYTES);
        const refs = await readReferences({ values: ['ref.png'], workspaceRoot: dir, ...REF_LIMITS });
        assert.equal(refs[0].mediaType, 'image/jpeg');
        assert.equal(refs[0].url, `data:image/jpeg;base64,${JPG_BYTES.toString('base64')}`);
        assert.equal(refs[0].bytes, JPG_BYTES.byteLength);
        // absolute paths are honored as-is
        const abs = await readReferences({ values: [join(dir, 'ref.png')], workspaceRoot: '/elsewhere', ...REF_LIMITS });
        assert.equal(abs[0].url, refs[0].url);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('references: unreadable, unsupported and oversized inputs fail naming the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imagegen-ref-bad-'));
    try {
        await assert.rejects(
            readReferences({ values: ['missing.png'], workspaceRoot: dir, ...REF_LIMITS }),
            /missing\.png/,
        );
        await writeFile(join(dir, 'notes.txt'), 'plain text');
        await assert.rejects(
            readReferences({ values: ['notes.txt'], workspaceRoot: dir, ...REF_LIMITS }),
            /notes\.txt.*not a supported reference image/s,
        );
        await writeFile(join(dir, 'big.png'), Buffer.concat([PNG_BYTES, Buffer.alloc(2048)]));
        await assert.rejects(
            readReferences({ values: ['big.png'], workspaceRoot: dir, ...REF_LIMITS }),
            /big\.png.*1024/s,
        );
        // each within the per-file cap, together over the total
        await writeFile(join(dir, 'a.png'), Buffer.concat([PNG_BYTES, Buffer.alloc(900)]));
        await assert.rejects(
            readReferences({
                values: ['a.png', 'a.png', 'a.png', 'a.png', 'a.png'],
                workspaceRoot: dir, ...REF_LIMITS,
            }),
            /reference images total .* 4096/s,
        );
    } finally { await rm(dir, { recursive: true, force: true }); }
});

// ------------------------------------------- capabilities.ts: reference gate

const REF_RECORD = {
    id: 'bytedance-seed/seedream-4.5',
    supported_parameters: {
        ...SEEDREAM_RECORD.supported_parameters,
        input_references: { type: 'range', min: 0, max: 2 },
    },
};

const REF_GATE = {
    descriptor: REF_RECORD.supported_parameters, descriptorKnown: true,
    alias: 'seedream', modelId: REF_RECORD.id, origin: 'call',
};

test('reference gate: the range descriptor bounds the COUNT, not the value', () => {
    assert.equal(gateReferences({ ...REF_GATE, count: 2 }), 'send');
    assert.throws(
        () => gateReferences({ ...REF_GATE, count: 3 }),
        /Invalid "input_references" for model bytedance-seed\/seedream-4\.5: 3 reference images, but the model accepts 0 to 2/,
    );
});

test('reference gate: a model without the parameter errors on a call arg, drops a default', () => {
    const noRefs = { ...REF_GATE, descriptor: SEEDREAM_RECORD.supported_parameters };
    assert.throws(
        () => gateReferences({ ...noRefs, count: 1 }),
        /bytedance-seed\/seedream-4\.5 does not support reference images/,
    );
    assert.equal(gateReferences({ ...noRefs, count: 1, origin: 'default' }), 'drop');
    assert.throws(
        () => gateReferences({ ...REF_GATE, count: 3, origin: 'default' }),
        /Configuration error: imagegen\.models\.seedream\.defaults\.input_references/,
    );
});

test('reference gate: unknown capabilities forward ungated, an empty list is omitted', () => {
    assert.equal(gateReferences({ ...REF_GATE, descriptor: undefined, descriptorKnown: false, count: 9 }), 'send');
    assert.equal(gateReferences({ ...REF_GATE, count: 0 }), 'drop');
});

// --------------------------------------------- plugin: image-to-image call

const REF_CONFIG_LIMITS = { maxReferenceBytes: 1024 * 1024, maxReferenceTotalBytes: 4 * 1024 * 1024 };

test('plugin: input_references are read once and sent in the wire shape', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-i2i-'));
    try {
        await writeFile(join(workspace, 'vorlage.png'), PNG_BYTES);
        let posts = 0;
        let body;
        const fetchImpl = async (url, init = {}) => {
            if (String(url).endsWith('/images/models')) return okRes({ data: [REF_RECORD] });
            posts += 1;
            body = JSON.parse(init.body);
            return okRes({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.04 } });
        };
        const { ctx, registered } = fakeCtx();
        apply(ctx, { ...CONFIG, ...REF_CONFIG_LIMITS, outputDir: 'i2i' }, { fetchImpl, workspaceRoot: workspace });
        const value = await registered[0].execute(
            { prompt: 'mach es aquarell', input_references: ['vorlage.png', 'https://example.test/x.jpg'] },
            { signal: new AbortController().signal },
        );
        assert.equal(posts, 1);
        assert.deepEqual(body.input_references, [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` } },
            { type: 'image_url', image_url: { url: 'https://example.test/x.jpg' } },
        ]);
        // the canonical value reports what was sent, without the base64 payload
        assert.deepEqual(value.applied.input_references, ['vorlage.png', 'https://example.test/x.jpg']);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('plugin: references against a model without the capability fail before any file is read', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-i2i-no-'));
    try {
        let posts = 0;
        const fetchImpl = async (url) => {
            if (String(url).endsWith('/images/models')) return okRes({ data: [SEEDREAM_RECORD] });
            posts += 1;
            return okRes({ data: [{ b64_json: PNG_B64 }], usage: { cost: 0 } });
        };
        const { ctx, registered } = fakeCtx();
        apply(ctx, { ...CONFIG, ...REF_CONFIG_LIMITS }, { fetchImpl, workspaceRoot: workspace });
        await assert.rejects(
            registered[0].execute(
                { prompt: 'x', input_references: ['nicht-mal-vorhanden.png'] },
                { signal: new AbortController().signal },
            ),
            /does not support reference images/,
        );
        assert.equal(posts, 0, 'the generation request is never sent');
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('plugin: output_format is a call parameter, gated like every other', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-fmt-'));
    try {
        const FLUX = {
            id: 'black-forest-labs/flux.2-pro',
            supported_parameters: { output_format: { type: 'enum', values: ['png', 'jpeg'] } },
        };
        let body;
        const fetchImpl = async (url, init = {}) => {
            if (String(url).endsWith('/images/models')) return okRes({ data: [FLUX, SEEDREAM_RECORD] });
            body = JSON.parse(init.body);
            return okRes({ data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.04 } });
        };
        const config = {
            ...CONFIG, ...REF_CONFIG_LIMITS, outputDir: 'fmt',
            models: { ...CONFIG.models, flux: { id: FLUX.id } },
        };
        const { ctx, registered } = fakeCtx();
        apply(ctx, config, { fetchImpl, workspaceRoot: workspace });
        await registered[0].execute(
            { prompt: 'x', model: 'flux', output_format: 'png' },
            { signal: new AbortController().signal },
        );
        assert.equal(body.output_format, 'png');
        // Seedream lists no output_format at all — a call arg must not be silently dropped.
        await assert.rejects(
            registered[0].execute(
                { prompt: 'x', output_format: 'png' },
                { signal: new AbortController().signal },
            ),
            /does not support the "output_format" parameter/,
        );
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

// -------------------------------------------------------------- settings.ts

test('settings: the base layer is exactly the config subset the card may edit', () => {
    const base = settingsFromConfig({ ...CONFIG, ...REF_CONFIG_LIMITS, showInChat: true });
    assert.deepEqual(Object.keys(base).sort(), [
        'defaultModel', 'maxImagesPerCall', 'maxReferenceBytes', 'maxReferenceTotalBytes',
        'models', 'outputDir', 'showInChat',
    ]);
    // Deployment decisions are NOT editable from the card.
    assert.equal(base.apiKeyEnv, undefined);
    assert.equal(base.baseURL, undefined);
    assert.equal(base.capabilityTtlMs, undefined);
    assert.equal(base.defaultModel, 'seedream');
    // A LIST, not the config's dict: mergeLayers merges plain objects recursively,
    // so a dict in the user layer could never delete an alias the base declares.
    assert.deepEqual(base.models, [
        { alias: 'seedream', id: 'bytedance-seed/seedream-4.5', defaults: { resolution: '2K', aspect_ratio: '16:9' } },
        { alias: 'pro', id: 'bytedance-seed/seedream-5-0-pro', defaults: {} },
    ]);
});

test('settings: a removed alias stays removed — the list replaces, it does not merge', () => {
    const base = settingsFromConfig({ ...CONFIG, ...REF_CONFIG_LIMITS });
    const withoutPro = base.models.filter((m) => m.alias !== 'pro');
    // What the card writes IS the whole registry, so the row is gone for good.
    assert.deepEqual(withoutPro.map((m) => m.alias), ['seedream']);
});

test('settings: duplicate, empty and slugless aliases are refused at write time', () => {
    const ok = { models: [{ alias: 'a', id: 'x/y', defaults: {} }] };
    assert.doesNotThrow(() => validateSettings(ok));
    assert.throws(() => validateSettings({ models: [
        { alias: 'a', id: 'x/y' }, { alias: 'a', id: 'x/z' },
    ] }), /"a" is listed more than once/);
    assert.throws(() => validateSettings({ models: [{ alias: '  ', id: 'x/y' }] }), /must not be empty/);
    assert.throws(() => validateSettings({ models: [{ alias: 'a', id: '' }] }), /names no model slug/);
});

test('settings: absent showInChat resolves to true, not undefined', () => {
    const { showInChat, ...withoutFlag } = { ...CONFIG, ...REF_CONFIG_LIMITS, showInChat: undefined };
    assert.equal(settingsFromConfig(withoutFlag).showInChat, true);
});

test('settings: isUsableSettings rejects a document without a model registry', () => {
    assert.equal(isUsableSettings({ models: [] }), true);
    assert.equal(isUsableSettings({ models: [{ alias: 'a', id: 'x/y' }] }), true);
    // The pre-list document shape is exactly what must NOT be adopted.
    assert.equal(isUsableSettings({ models: { seedream: { id: 'x/y' } } }), false);
    assert.equal(isUsableSettings({ models: [{ id: 'x/y' }] }), false);
    assert.equal(isUsableSettings({}), false);
    assert.equal(isUsableSettings(undefined), false);
});

test('settings: the namespace registers with the config as base and applies live', () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const settings = fakeSettings();
    const { ctx } = fakeCtx(undefined, undefined, settings);
    apply(ctx, { ...CONFIG, ...REF_CONFIG_LIMITS }, { fetchImpl: ChatFetch() });
    assert.equal(settings.state.registered.ns, 'dsh-tool-imagegen');
    assert.equal(settings.state.registered.options.applies, 'live');
    assert.deepEqual(settings.state.registered.options.base.models.map((m) => m.alias), ['seedream', 'pro']);
    assert.equal(typeof settings.state.registered.options.validate, 'function');
    assert.ok(settings.state.registered.schema, 'a schema is registered for the card to render');
});

test('settings: a committed change reaches the NEXT call without a restart', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-settings-'));
    try {
        const settings = fakeSettings();
        const { ctx, registered, runEffects } = fakeCtx(undefined, undefined, settings);
        apply(ctx, { ...CONFIG, ...REF_CONFIG_LIMITS }, { fetchImpl: ChatFetch(), workspaceRoot: workspace });
        runEffects();
        const tool = registered[0];
        const exec = { signal: new AbortController().signal };

        // Config state: alias "neu" does not exist, n = 4 is allowed.
        await assert.rejects(tool.execute({ prompt: 'x', model: 'neu' }, exec), /Unknown model alias "neu"/);

        settings.emit({
            ...settingsFromConfig({ ...CONFIG, ...REF_CONFIG_LIMITS }),
            models: settingsFromConfig({ ...CONFIG, ...REF_CONFIG_LIMITS }).models
                .concat([{ alias: 'neu', id: 'bytedance-seed/seedream-4.5', defaults: {} }]),
            maxImagesPerCall: 1,
            outputDir: 'aus-der-karte',
        });

        // The new alias is reachable and the lowered cap bites, same process.
        const value = await tool.execute({ prompt: 'x', model: 'neu' }, exec);
        assert.equal(value.alias, 'neu');
        assert.match(value.images[0].path, /aus-der-karte/);
        await assert.rejects(
            tool.execute({ prompt: 'x', n: 2 }, exec),
            /exceeds the configured maxImagesPerCall = 1/,
        );
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('settings: a hand-edited document without models is refused, the last good value stands', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-settings-bad-'));
    try {
        const settings = fakeSettings();
        const { ctx, registered, runEffects } = fakeCtx(undefined, undefined, settings);
        apply(ctx, { ...CONFIG, ...REF_CONFIG_LIMITS }, { fetchImpl: ChatFetch(), workspaceRoot: workspace });
        runEffects();
        settings.emit({ models: { seedream: { id: 'x' } }, defaultModel: 'weg' });
        const value = await registered[0].execute({ prompt: 'x' }, { signal: new AbortController().signal });
        assert.equal(value.alias, 'seedream', 'the unusable document did not replace the live settings');
    } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('settings: without a settings service the config governs and the tool still works', async () => {
    process.env.IMAGEGEN_TEST_KEY = 'test-key';
    const workspace = await mkdtemp(join(tmpdir(), 'imagegen-nosettings-'));
    try {
        const { ctx, registered } = fakeCtx();
        apply(ctx, { ...CONFIG, ...REF_CONFIG_LIMITS, outputDir: 'aus-der-config' }, {
            fetchImpl: ChatFetch(), workspaceRoot: workspace,
        });
        const value = await registered[0].execute({ prompt: 'x' }, { signal: new AbortController().signal });
        assert.match(value.images[0].path, /aus-der-config/);
    } finally { await rm(workspace, { recursive: true, force: true }); }
});
