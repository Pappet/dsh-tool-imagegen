/**
 * Browser-half tests: mount `lib/client.js` in jsdom against a stub client
 * context and drive the two cards it registers.
 *
 * This file exists because the client half is hand-written `React.create-
 * Element` that no build step ever looks at: `tsc` does not read it and
 * `node --check` only proves it parses. A deleted style constant, a service
 * read that throws, a card that renders collapsed and dies on expand — all of
 * that is invisible until a person clicks it. So the test clicks it.
 *
 * The stub context mirrors the real one where it matters: `ctx.get(name)`
 * answers `undefined` for an absent service (never throws), and
 * `ctx.inject(names, cb)` hands back a context carrying the named service as a
 * property.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ONE document for the whole file, installed as globals BEFORE react-dom is
// loaded: react-dom binds its event system at import time, and a static import
// would be hoisted above this setup — it would then initialise without a DOM
// and silently drop every dispatched event, so a typed character would never
// reach a component.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.Blob = dom.window.Blob;
global.URL = dom.window.URL;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
const { act } = await import('react');
const ReactDOM = (await import('react-dom/client')).default;

/** Type into a controlled input the way a person would. */
async function type(input, text) {
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => {
        setValue.call(input, text);
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
}

const SNAPSHOT = {
    status: 'ready',
    value: {
        models: [
            { alias: 'seedream', id: 'bytedance-seed/seedream-4.5', defaults: { resolution: '2K' } },
            { alias: 'muse-image', id: 'meta/muse-image', defaults: {} },
        ],
        defaultModel: 'seedream',
        outputDir: '.dsh/images',
        showInChat: true,
        maxImagesPerCall: 4,
        maxReferenceBytes: 8 * 1024 * 1024,
        maxReferenceTotalBytes: 32 * 1024 * 1024,
    },
    base: {},
    user: {},
    revision: 3,
    writable: true,
    mode: 'host',
};

/** Load the bundle against a stub context; returns what it registered. */
function mount({ snapshot = SNAPSHOT, locale = true, settings = true } = {}) {
    dom.window.document.getElementById('root').innerHTML = '';
    const registrations = [];
    const dictionaries = [];
    const writes = [];
    const scope = {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        set: async (field, value) => { writes.push(['set', field, value]); },
        unset: async (field) => { writes.push(['unset', field]); },
    };
    const services = {
        sessions: { list: { getSnapshot: () => ({ current: undefined }) }, binding: () => undefined },
        ...(settings ? { settingsScope: { bind: () => scope } } : {}),
        ...(locale ? { locale: { register: (ns, dicts) => { dictionaries.push([ns, dicts]); return () => {}; } } } : {}),
    };
    const ctx = {
        // The real accessor answers undefined for an absent service.
        get: (name) => services[name],
        effect: (fn) => { fn(); },
        inject: (names, cb) => cb(Object.assign(Object.create(ctx), {
            slots: ctx.slots,
            ...Object.fromEntries(names.map((n) => [n, services[n]])),
        })),
        slots: {
            inject: (_name, fn) => fn(),
            register: (opts, component) => { registrations.push({ opts, component }); return () => {}; },
        },
    };

    let exported;
    window.__ModuleLoader__ = { load: ({ factory }) => { exported = factory((n) => {
        if (n === 'react') return React;
        throw new Error(`unexpected require(${n})`);
    }); } };
    // eslint-disable-next-line no-eval -- the bundle is an IIFE against window.
    (0, eval)(CLIENT_SOURCE);
    exported.apply(ctx);
    return { registrations, dictionaries, writes, ctx };
}

/** Render one registered slot component into the jsdom document. */
async function render(component, props = {}) {
    const container = dom.window.document.getElementById('root');
    const root = ReactDOM.createRoot(container);
    // A key the dictionaries do not carry must surface as itself, not throw.
    const t = (key) => key;
    await act(async () => { root.render(React.createElement(component, { t, ...props })); });
    return container;
}

function click(element) {
    return act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
}

test('client: both cards register, keyed to the locale namespace', () => {
    const { registrations, dictionaries } = mount();
    const keys = registrations.map((r) => `${r.opts.name}:${r.opts.key}`);
    assert.deepEqual(keys, ['tool.call.toolview:generate_image', 'settings.plugin.item:dsh-tool-imagegen']);
    assert.ok(registrations.every((r) => r.opts.locale === 'dsh-tool-imagegen'));
    assert.equal(dictionaries.length, 1);
    assert.deepEqual(Object.keys(dictionaries[0][1]).sort(), ['en', 'zh']);
});

test('client: the dictionaries carry the same keys in both languages', () => {
    const { dictionaries } = mount();
    const { en, zh } = dictionaries[0][1];
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
    assert.ok(Object.values(zh).every((v) => typeof v === 'string' && v !== ''));
});

test('client: without the locale service the cards still register, unkeyed', () => {
    const { registrations, dictionaries } = mount({ locale: false });
    assert.equal(dictionaries.length, 0);
    assert.equal(registrations.length, 2);
    assert.ok(registrations.every((r) => r.opts.locale === undefined));
});

test('client: without the settings service only the tool card registers', () => {
    const { registrations } = mount({ settings: false });
    assert.deepEqual(registrations.map((r) => r.opts.name), ['tool.call.toolview']);
});

test('client: the settings card survives being expanded', async () => {
    const { registrations } = mount();
    const card = registrations.find((r) => r.opts.name === 'settings.plugin.item');
    const container = await render(card.component);
    assert.equal(container.querySelectorAll('input').length, 0, 'collapsed by default');

    await click(container.querySelector('button'));
    // 6 scalar fields + 3 columns for each of the 2 alias rows.
    assert.equal(container.querySelectorAll('input').length, 12);
    const values = [...container.querySelectorAll('input')].map((i) => i.value);
    assert.ok(values.includes('bytedance-seed/seedream-4.5'), values.join(' | '));
});

test('client: the byte caps are shown and staged in MiB', async () => {
    const { registrations, writes } = mount();
    const card = registrations.find((r) => r.opts.name === 'settings.plugin.item');
    const container = await render(card.component);
    await click(container.querySelector('button'));

    const perFile = container.querySelector('#imagegen-maxReferenceBytes');
    assert.equal(perFile.value, '8', '8 MiB, not 8388608');

    await type(perFile, '16');
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'save');
    await click(save);
    assert.deepEqual(writes, [['set', 'maxReferenceBytes', 16 * 1024 * 1024]], 'the document keeps bytes');
});

test('client: removing an alias writes the whole list without it', async () => {
    const { registrations, writes } = mount();
    const card = registrations.find((r) => r.opts.name === 'settings.plugin.item');
    const container = await render(card.component);
    await click(container.querySelector('button'));

    const remove = [...container.querySelectorAll('button')].filter((b) => b.textContent === 'removeRow');
    assert.equal(remove.length, 2);
    await click(remove[1]);

    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'save');
    await click(save);
    // A LIST, so the removal is the whole registry — not a sparse patch that
    // would re-inherit the row from the composition base.
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], 'models');
    assert.deepEqual(writes[0][2].map((m) => m.alias), ['seedream']);
});

test('client: an invalid row blocks saving instead of writing something the host rejects', async () => {
    const { registrations, writes } = mount();
    const card = registrations.find((r) => r.opts.name === 'settings.plugin.item');
    const container = await render(card.component);
    await click(container.querySelector('button'));

    const defaultsField = container.querySelectorAll('input')[8]; // first row, defaults column
    await type(defaultsField, '{not json');
    assert.ok(container.textContent.includes('rowBadDefaults'));
    const save = [...container.querySelectorAll('button')].find((b) => b.textContent === 'save');
    assert.equal(save.disabled, true);
    assert.deepEqual(writes, []);
});

test('client: a read-only document disables every control', async () => {
    const { registrations } = mount({ snapshot: { ...SNAPSHOT, writable: false } });
    const card = registrations.find((r) => r.opts.name === 'settings.plugin.item');
    const container = await render(card.component);
    await click(container.querySelector('button'));
    assert.ok(container.textContent.includes('readOnly'));
    assert.ok([...container.querySelectorAll('input')].every((i) => i.disabled));
});

test('client: an unavailable namespace still renders the card shell', async () => {
    const { registrations } = mount({ snapshot: { ...SNAPSHOT, status: 'unavailable', value: undefined } });
    const card = registrations.find((r) => r.opts.name === 'settings.plugin.item');
    const container = await render(card.component);
    assert.ok(container.textContent.includes('unavailable'));
    assert.equal(container.querySelectorAll('li').length, 1);
});

test('client: the tool card falls back to the path list without attachments', async () => {
    const { registrations } = mount();
    const card = registrations.find((r) => r.opts.name === 'tool.call.toolview');
    const block = {
        kind: 'tool-result',
        isError: false,
        meta: { model: 'bytedance-seed/seedream-4.5', images: [{ path: '/w/a.jpg' }] },
    };
    const container = await render(card.component, { block, openFile: () => {} });
    assert.ok(container.textContent.includes('/w/a.jpg'));
});

test('client: a running call renders the prompt excerpt, not a crash', async () => {
    const { registrations } = mount();
    const card = registrations.find((r) => r.opts.name === 'tool.call.toolview');
    const block = { argsRaw: JSON.stringify({ prompt: 'a paper whale' }) };
    const container = await render(card.component, { block });
    assert.ok(container.textContent.includes('a paper whale'));
});

test('client: one stylesheet is injected, once', () => {
    mount();
    const tags = dom.window.document.querySelectorAll('style[data-plugin-css]');
    assert.equal(tags.length, 1);
    assert.equal(tags[0].dataset.pluginCss, 'dsh-tool-imagegen/cards.css');
    mount(); // a second activation must not stack a second sheet
    assert.equal(dom.window.document.querySelectorAll('style[data-plugin-css]').length, 1);
});

test('client: every class the components name is defined in that stylesheet', () => {
    const defined = new Set([...CLIENT_SOURCE.matchAll(/\.(dsi-[a-z-]+)[{,: ]/g)].map((m) => m[1]));
    const used = new Set([...CLIENT_SOURCE.matchAll(/className: "([^"]+)"/g)]
        .flatMap((m) => m[1].split(' ')));
    const unknown = [...used].filter((c) => !defined.has(c));
    assert.deepEqual(unknown, [], `classes with no rule: ${unknown}`);
    assert.equal(/\bstyle: /.test(CLIENT_SOURCE), false, 'no inline style objects left');
});

test('client: styles use theme aliases, never literal colours', () => {
    // web-styling.md: "Do not copy static palette values or write literal colors
    // in feature components." A third-party bundle has no CSS modules, but the
    // rule about WHICH values it may name still applies.
    const literals = CLIENT_SOURCE.match(/var\(--dsw[a-z0-9-]*, *(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g);
    assert.equal(literals, null, `literal colour fallbacks: ${literals}`);
    // Every alias this bundle names must be one the theme package defines.
    const KNOWN = new Set([
        '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3', '--dsw-alias-bg-module-platform',
        '--dsw-alias-border-l2', '--dsw-alias-brand-primary', '--dsw-alias-label-dimmed',
        '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
        '--dsw-alias-state-error-primary',
        // Named by the harness's own fields.module.css and defined nowhere yet;
        // it carries a real token as its fallback.
        '--dsw-alias-label-error',
    ]);
    const used = new Set(CLIENT_SOURCE.match(/--dsw-alias-[a-z0-9-]+/g) ?? []);
    const unknown = [...used].filter((t) => !KNOWN.has(t));
    assert.deepEqual(unknown, [], `unknown design tokens: ${unknown}`);
});
