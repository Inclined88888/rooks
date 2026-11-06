/**
 * The Hermes card of the agent import (plugins/agent-import), mounted from the
 * shipped `lib/client.js` the way the platform loads it: absent when the
 * daemon finds no Hermes or refuses the account, every profile checked when it
 * does, and exactly the checked profiles sent to `hermes/stage` before the
 * normal preview opens.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';

type Manifest = { timon: { id: string; client: { slots: string[] } } };
type Call = { url: string; method: string; body: unknown };
type Reply = { status: number; body: unknown };

const repo = resolve(process.cwd(), '..');
const pluginDir = join(repo, 'plugins', 'agent-import');
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as Manifest;
const tmp = mkdtempSync(join(tmpdir(), 'agent-import-hermes-card-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const install = (key: string, value: unknown) => {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
};

type Platform = {
  React: typeof import('react');
  createRoot: typeof import('react-dom/client').createRoot;
  register: typeof import('./plugin-host/slots').register;
  resetSlotsForTests: typeof import('./plugin-host/slots').resetSlotsForTests;
  slotEntries: typeof import('./plugin-host/slots').slotEntries;
  clientContext: typeof import('./plugin-host/loader').clientContext;
  UI_LAYOUT_CHILD_SLOTS: typeof import('./plugin-host/ui-layout').UI_LAYOUT_CHILD_SLOTS;
  client: { apply(ctx: unknown): () => void };
};

let loading: Promise<Platform> | null = null;

/** A DOM, the platform's modules, then the browser half with its `react` and `@timon/ui` imports bound to them. */
function platform(): Promise<Platform> {
  loading ??= (async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'DocumentFragment', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle'] as const) {
      install(key, (dom.window as unknown as Record<string, unknown>)[key]);
    }
    install('IS_REACT_ACT_ENVIRONMENT', true);
    const React = await import('react');
    // The kit's components are compiled with the classic JSX runtime.
    install('React', React);
    const { createRoot } = await import('react-dom/client');
    const { UI_KIT } = await import('./plugin-host/ui-kit');
    const { Slot } = await import('./plugin-host/render');
    const { register, resetSlotsForTests, slotEntries } = await import('./plugin-host/slots');
    const { clientContext } = await import('./plugin-host/loader');
    const { UI_LAYOUT_CHILD_SLOTS } = await import('./plugin-host/ui-layout');

    const source = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8');
    const bound = source
      .replace(/^import (\w+) from "react";$/gm, 'const $1 = globalThis.__hermesCardReact;')
      .replace(/^import \* as (\w+) from "@timon\/ui";$/gm, 'const $1 = globalThis.__hermesCardUi;');
    assert.doesNotMatch(bound, /^import /m, 'every import of the bundle is the platform\'s');
    install('__hermesCardReact', React);
    install('__hermesCardUi', { ...UI_KIT, Slot });
    const file = join(tmp, 'client.mjs');
    writeFileSync(file, bound);
    const client = await import(pathToFileURL(file).href) as { apply(ctx: unknown): () => void };
    return { React, createRoot, register, resetSlotsForTests, slotEntries, clientContext, UI_LAYOUT_CHILD_SLOTS, client };
  })();
  return loading;
}

const STAGED = { token: 'T'.repeat(43), sha256: 'a'.repeat(64), size: 321, expiresAt: Date.now() + 3_600_000 };
const PREVIEW = {
  archive: { sha256: STAGED.sha256, size: STAGED.size, expiresAt: STAGED.expiresAt },
  ready: true,
  preview: {
    source: { app: 'hermes', exportedAt: null },
    warnings: [],
    agents: [{ sourceRef: 'hermes:default', displayName: 'Hermes', finalName: 'hermes.default', action: 'create', warnings: [] }],
  },
};

/** Mounts the import's settings section against a fake daemon; `replies` answers by route. */
async function mount(replies: Record<string, Reply>) {
  const { React, createRoot, register, resetSlotsForTests, slotEntries, clientContext, UI_LAYOUT_CHILD_SLOTS, client } = await platform();
  const calls: Call[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const route = String(input).replace(/^\/api\/ui\/plugins\/agent-import\//, '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : init?.body;
    calls.push({ url: route, method: init?.method ?? 'GET', body });
    const reply = replies[route] ?? { status: 404, body: { error: 'no route', code: 'not_found' } };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  });
  resetSlotsForTests();
  register({ slot: 'root', pluginId: '@timon/ui-layout', children: UI_LAYOUT_CHILD_SLOTS }, () => null);
  const dispose = client.apply(clientContext(manifest.timon.id, manifest.timon.client.slots));
  const section = slotEntries('settings.section').find((e) => e.pluginId === manifest.timon.id);
  assert.ok(section, 'the import paints its settings section');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(section.Component as ComponentType));
  });
  // The detection answers after the first paint.
  await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    container.remove();
    dispose();
    resetSlotsForTests();
  };
  return { calls, container, unmount, act: React.act };
}

const card = (container: Element) => container.querySelector('[data-source="hermes"]');
const boxes = (container: Element) => Array.from(container.querySelectorAll<HTMLInputElement>('[data-source="hermes"] input[type="checkbox"]'));
const importButton = (container: Element) => Array.from(container.querySelectorAll('button'))
  .find((b) => /Hermes/.test(b.textContent ?? '') && b.closest('[data-source="hermes"]')) as HTMLButtonElement | undefined;

test('no Hermes on the daemon\'s machine: no card, the other sources stay', async () => {
  const m = await mount({ hermes: { status: 200, body: { found: false, profiles: [] } } });
  try {
    assert.ok(!card(m.container));
    assert.ok(m.container.querySelector('input[type="file"]'), 'the zip sources are still offered');
    assert.deepEqual(m.calls.map((c) => `${c.method} ${c.url}`), ['GET hermes']);
  } finally {
    await m.unmount();
  }
});

test('an account the daemon refuses sees no card, and no error', async () => {
  const m = await mount({ hermes: { status: 403, body: { error: 'forbidden', code: 'forbidden' } } });
  try {
    assert.ok(!card(m.container));
    assert.ok(!m.container.querySelector('[role="alert"]'));
  } finally {
    await m.unmount();
  }
});

test('found: every profile checked, the label shown, and only the checked ones staged', async () => {
  const m = await mount({
    hermes: { status: 200, body: { found: true, label: '~/.hermes', profiles: [{ name: 'default', displayName: 'Hermes' }, { name: 'coder', displayName: 'coder' }] } },
    'hermes/stage': { status: 201, body: STAGED },
    preview: { status: 200, body: PREVIEW },
  });
  try {
    assert.ok(card(m.container), 'the card is painted');
    assert.match(card(m.container)!.textContent ?? '', /~\/\.hermes/);
    assert.deepEqual(boxes(m.container).map((b) => [b.name, b.checked]), [['default', true], ['coder', true]]);

    await m.act(async () => { boxes(m.container)[1]!.click(); });
    assert.deepEqual(boxes(m.container).map((b) => b.checked), [true, false]);
    await m.act(async () => { boxes(m.container)[0]!.click(); });
    assert.equal(importButton(m.container)?.disabled, true, 'nothing checked, nothing to import');
    await m.act(async () => { boxes(m.container)[0]!.click(); });

    await m.act(async () => { importButton(m.container)!.click(); });
    await m.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const stage = m.calls.find((c) => c.url === 'hermes/stage');
    assert.deepEqual(stage, { url: 'hermes/stage', method: 'POST', body: { profiles: ['default'] } });
    const preview = m.calls.find((c) => c.url === 'preview');
    assert.deepEqual(preview?.body, { token: STAGED.token }, 'the preview opens on the staged token');
    assert.ok(!card(m.container), 'the source step gave way to the preview');
    assert.match(m.container.textContent ?? '', /hermes\.default/);
  } finally {
    await m.unmount();
  }
});

test('a profile gone between detection and import reads as Hermes not found', async () => {
  const m = await mount({
    hermes: { status: 200, body: { found: true, label: '~/.hermes', profiles: [{ name: 'default', displayName: 'Hermes' }] } },
    'hermes/stage': { status: 404, body: { error: 'No Hermes profile named default was found.', code: 'not_found' } },
  });
  try {
    await m.act(async () => { importButton(m.container)!.click(); });
    await m.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const alert = m.container.querySelector('[role="alert"]');
    assert.ok(alert, 'the failure is shown');
    assert.match(alert.textContent ?? '', /Hermes/);
    assert.doesNotMatch(alert.textContent ?? '', /archive/i, 'not the words of an expired archive');
    assert.equal(m.calls.some((c) => c.url === 'preview'), false);
  } finally {
    await m.unmount();
  }
});
