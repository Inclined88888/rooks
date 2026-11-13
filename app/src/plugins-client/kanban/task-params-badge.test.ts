/**
 * The Kanban card's LLM chip (`task-params-badge.tsx`) in jsdom, inside a card
 * that counts its own clicks: on a PENDING task a click opens the ModelPicker
 * without opening the card, a pick shows at once and is saved through the
 * task update route, a refusal puts the chip back with a toast; on a task
 * IN_PROGRESS the chip only reads, its details still on hover.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { waitUntil } from '../../lib/test-wait';
import type { BackendCatalog } from '@/lib/backends';
import type { TaskParamsSource } from './task-params-badge';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    {
      id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      models: [{ slug: 'opus', label: 'Opus', presetRank: 1 }, { slug: 'haiku', label: 'Haiku', presetRank: 2 }],
    },
  ],
};

type Daemon = { status: number; puts: { url: string; body: unknown }[]; release: (() => void)[] };

async function mount(task: TaskParamsSource, daemon: Daemon, catalog: BackendCatalog = CATALOG) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/ui/backends/catalog')) return json(catalog);
    if (url.endsWith('/api/ui/prefs/model-favorites')) return json({ favorites: [] });
    if (url.startsWith('/api/ui/tasks/') && init?.method === 'PUT') {
      daemon.puts.push({ url, body: JSON.parse(String(init.body)) });
      await new Promise<void>((resolve) => { daemon.release.push(resolve); });
      return daemon.status === 200 ? json({ task: {} }) : json({ error: 'refused by the daemon' }, daemon.status);
    }
    return json({ error: 'not found' }, 404);
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { invalidateBackendCatalog } = await import('@/lib/backends');
  const { resetModelFavoritesForTest } = await import('@/hooks/use-model-favorites');
  invalidateBackendCatalog();
  resetModelFavoritesForTest();
  const { TaskParamsBadge } = await import('./task-params-badge');

  let cardClicks = 0;
  let reads = 0;
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement('article', { onClick: () => { cardClicks++; } },
      React.createElement(TaskParamsBadge, { task, onSaved: async () => { reads++; } })));
  });

  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
  const row = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-picker-row]')).find((el) => el.textContent?.includes(text));
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const chip = () => $<HTMLButtonElement>('[data-task-params] button[aria-haspopup="dialog"]');
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return {
    React, $, row, click, chip, until, unmount,
    cardClicks: () => cardClicks, reads: () => reads,
    releasePut: async () => { await React.act(async () => { daemon.release.shift()?.(); }); },
  };
}

const PENDING: TaskParamsSource = {
  id: 't1', status: 'PENDING', backend_override: null, model_override: null,
  effective_backend: 'claude', effective_model: 'opus', permission_mode_override: 'plan',
};

function daemon(status = 200): Daemon {
  return { status, puts: [], release: [] };
}

test('PENDING: a click opens the picker, not the card; a pick shows at once and is saved', async () => {
  const d = daemon();
  const m = await mount(PENDING, d);
  try {
    assert.ok(m.chip(), 'the chip is a picker trigger');
    await m.click(m.chip());
    await m.until(() => !!m.row('Haiku'), 'the picker rows');
    await m.click(m.row('Haiku'));
    assert.equal(m.cardClicks(), 0, 'neither the chip nor the panel opens the card');
    await m.until(() => d.puts.length === 1, 'the update to be sent');
    assert.deepEqual(d.puts[0], { url: '/api/ui/tasks/t1', body: { backend_override: 'claude', model_override: 'haiku' } });
    assert.match(m.chip()?.textContent ?? '', /haiku/, 'optimistic: the pick shows before the daemon answers');
    assert.equal(m.chip()?.disabled, true, 'no second pick while the first is in flight');
    await m.releasePut();
    await m.until(() => m.reads() === 1, 'the board to be re-read');
  } finally {
    await m.unmount();
  }
});

test('PENDING: a refusal puts the chip back and says why', async (t) => {
  const { toast } = createRequire(join(process.cwd(), 'package.json'))('sonner') as typeof import('sonner');
  const errors = t.mock.method(toast, 'error', () => '');
  const d = daemon(409);
  const m = await mount({ ...PENDING, status: 'BLOCKED' }, d);
  try {
    await m.click(m.chip());
    await m.until(() => !!m.row('Haiku'), 'the picker rows');
    await m.click(m.row('Haiku'));
    await m.until(() => d.puts.length === 1, 'the update to be sent');
    await m.releasePut();
    await m.until(() => errors.mock.callCount() === 1, 'the refusal toast');
    assert.match(String(errors.mock.calls[0]?.arguments[0]), /refused by the daemon/);
    await m.until(() => /opus/.test(m.chip()?.textContent ?? ''), 'the chip to be put back');
    assert.equal(m.reads(), 0);
  } finally {
    await m.unmount();
  }
});

test('IN_PROGRESS: the chip is a plain label, no hover details nor help cursor', async () => {
  const d = daemon();
  const m = await mount({ ...PENDING, status: 'IN_PROGRESS' }, d);
  try {
    assert.ok(!m.chip(), 'no picker trigger');
    const chip = m.$('[data-task-params="read-only"]');
    assert.ok(chip);
    assert.ok(!chip.querySelector('button'));
    assert.ok(!chip.querySelector('[role="tooltip"]'), 'the details live in the popup');
    assert.doesNotMatch(chip.className, /cursor-help/);
    assert.doesNotMatch(chip.textContent ?? '', /▾/, 'no dropdown mark on a chip that opens nothing');
    await m.click(chip);
    assert.equal(m.cardClicks(), 1, 'a click on a read-only chip opens the card as before');
    assert.ok(!m.$('[role="dialog"]'));
  } finally {
    await m.unmount();
  }
});

test('an account instance reads as its nickname, an unlisted one as its id (TODO #454)', async () => {
  const claude = CATALOG.backends[0]!;
  const withAccount: BackendCatalog = {
    ...CATALOG,
    backends: [...CATALOG.backends, { ...claude, id: 'claude@1oikjpok09', label: 'Claude · Perso', instanceOf: 'claude', account: { id: '1oikjpok09', name: 'Perso', state: 'active' } }],
  };
  // The backend is named in the hover details, which only a queued task's chip carries.
  const onAccount = { ...PENDING, effective_backend: 'claude@1oikjpok09' };
  const m = await mount(onAccount, daemon(), withAccount);
  try {
    const chip = () => m.$('[data-task-params]')?.textContent ?? '';
    await m.until(() => chip().includes('Perso'), 'the nickname once the catalogue is read');
    assert.doesNotMatch(chip(), /1oikjpok09/, 'neither the chip nor its details show the raw id');
  } finally {
    await m.unmount();
  }
  const gone = await mount({ ...onAccount, effective_backend: 'claude@gone' }, daemon(), withAccount);
  try {
    await gone.until(() => (gone.$('[data-task-params]')?.textContent ?? '').includes('claude@gone'), 'the id of an account the catalogue does not list');
  } finally {
    await gone.unmount();
  }
});
