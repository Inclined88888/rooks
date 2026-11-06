/**
 * The context-window gauge and its panel (TODO #504): the window in detail,
 * the LLM, the mission's tokens, compaction in one click with its progress.
 *
 * And: gauge → "Compact onto another model…" → the LLM dialog → Cancel. A
 * dialog opened from a Radix menu item while the menu is still closing used
 * to leave `pointer-events: none` on <body>: no click worked afterwards, with
 * nothing visible on top (TIM-0035).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import type { CompactStore } from '../../lib/mission-compact';

const INFO = { used: 132_000, limit: 200_000, model: 'opus', backend: 'Claude Code · Perso', totalIn: 1_250_000, totalOut: 48_000 };

type MountOptions = { store?: CompactStore; nativeCompact?: boolean; thinking?: boolean; info?: typeof INFO };

async function mount(opts: MountOptions = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  // Two focus traps that fight over the focus bounce it back and forth
  // forever: turn that into a failure instead of a frozen test run.
  let focusCalls = 0;
  const nativeFocus = dom.window.HTMLElement.prototype.focus;
  dom.window.HTMLElement.prototype.focus = function (this: HTMLElement, ...args: Parameters<HTMLElement['focus']>) {
    focusCalls += 1;
    if (focusCalls > 500) throw new Error('focus is bouncing between two traps');
    return nativeFocus.apply(this, args);
  };

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { Dialog, DialogContent, DialogTitle, DialogFooter } = await import('../ui/dialog');
  const { ContextGaugeMenu } = await import('./context-gauge-menu');
  const { ContextRing } = await import('./context-ring');
  const { createCompactStore, isRunning, useMissionCompaction } = await import('../../lib/mission-compact');
  const store = opts.store ?? createCompactStore({
    fetch: async () => new Response(JSON.stringify({ operation: null }), { status: 200 }),
    onProgress: () => () => {},
    pollMs: 60_000,
  });

  const state = { open: false, outside: 0 };
  function Gauge() {
    const compaction = useMissionCompaction('m1', store);
    return React.createElement(ContextGaugeMenu, {
      trigger: React.createElement('button', { type: 'button', id: 'gauge' },
        React.createElement(ContextRing, { used: INFO.used, limit: INFO.limit, label: 'ctx', busy: compaction.starting || isRunning(compaction.operation) })),
      info: opts.info ?? INFO,
      compaction,
      nativeCompact: opts.nativeCompact ?? false,
      thinking: opts.thinking ?? false,
      onCompact: () => { void store.start('m1'); },
      onCompactElsewhere: () => { state.open = true; void render(); },
      onOpenTarget: null,
    });
  }
  const root = createRoot(document.getElementById('root')!);
  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null,
        React.createElement(Gauge),
        React.createElement('button', { type: 'button', id: 'outside', onClick: () => { state.outside += 1; } }, 'Outside'),
        React.createElement(Dialog, { open: state.open, onOpenChange: (open: boolean) => { state.open = open; void render(); } },
          React.createElement(DialogContent, { hideClose: true, 'aria-describedby': undefined },
            React.createElement(DialogTitle, null, 'Compact'),
            React.createElement(DialogFooter, null,
              React.createElement('button', { type: 'button', id: 'cancel', onClick: () => { state.open = false; void render(); } }, 'Cancel'))))));
    });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await render();
  const key = async (target: Element, keyName: string) => {
    await React.act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, code: keyName, bubbles: true, cancelable: true }));
    });
  };
  const click = async (target: HTMLElement) => {
    await React.act(async () => { target.click(); });
  };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); };
  const openPanel = async () => {
    const gauge = document.getElementById('gauge')!;
    gauge.focus();
    await key(gauge, 'Enter');
    await until(() => !!document.querySelector('[data-gauge-usage]'), 'the gauge panel to open');
  };
  const item = (text: RegExp) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
    .find((node) => text.test(node.textContent ?? ''));
  return { state, until, key, click, unmount, openPanel, item, act: React.act };
}

function storeHarness(post: () => Response) {
  const posts: Array<string | null> = [];
  let emit: ((data: unknown) => void) | null = null;
  return {
    posts,
    emit: (data: unknown) => emit?.(data),
    async make() {
      const { createCompactStore } = await import('../../lib/mission-compact');
      return createCompactStore({
        fetch: async (_url, init) => {
          if (init?.method === 'POST') {
            posts.push(typeof init.body === 'string' ? init.body : null);
            return post();
          }
          return new Response(JSON.stringify({ operation: null }), { status: 200 });
        },
        onProgress: (fn) => { emit = fn; return () => { emit = null; }; },
        pollMs: 60_000,
      });
    },
  };
}

const OPERATION = {
  id: 'op-1', missionId: 'm1', mode: 'native', phase: 'started', backend: 'claude', model: 'opus',
  targetMissionId: null, error: null, startedAt: 1000, updatedAt: 1000,
};

test('the panel shows the window, the LLM and the mission tokens', async () => {
  const ui = await mount({ nativeCompact: true });
  try {
    await ui.openPanel();
    const text = document.body.textContent ?? '';
    assert.match(text, /66%/);
    assert.match(text, /132k \/ 200k tokens/);
    assert.match(text, /opus/);
    assert.match(text, /Claude Code · Perso/);
    assert.match(text, /48k generated/);
    assert.doesNotMatch(text, /1\.3M/, 'the input total leaves out the cache: not shown');
    assert.doesNotMatch(text, /Near the limit/, '66 % is under the advice threshold');
  } finally {
    await ui.unmount();
  }
});

test('near the limit the panel advises compacting', async () => {
  const ui = await mount({ info: { ...INFO, used: 172_000 } });
  try {
    await ui.openPanel();
    assert.match(document.body.textContent ?? '', /Near the limit: compacting is advised/);
  } finally {
    await ui.unmount();
  }
});

test('one click compacts on the same LLM, and the progress follows the stream', async () => {
  const h = storeHarness(() => new Response(JSON.stringify({ operation: OPERATION }), { status: 202 }));
  const store = await h.make();
  const ui = await mount({ store, nativeCompact: true });
  try {
    await ui.openPanel();
    const action = document.querySelector<HTMLElement>('[data-compact-action]');
    assert.ok(action, 'the primary action is offered');
    assert.equal(action.textContent, 'Compact', 'a short label, no paragraph in the button');
    assert.match(action.getAttribute('title') ?? '', /same conversation/, 'native: the tooltip says the conversation stays');
    assert.ok(!document.querySelector('[data-compact-hint]'), 'native: no hint line');
    await ui.key(action, 'Enter');
    await ui.until(() => h.posts.length === 1, 'the POST to go out');
    assert.equal(h.posts[0], '{}', 'no target: same LLM, no picker');
    await ui.until(() => !!document.querySelector('[data-compact-phase="started"]'), 'the progress to show');
    assert.ok(document.querySelector('[data-busy="true"]'), 'the ring turns while it runs');
    assert.ok(document.querySelector('[data-gauge-usage]'), 'the panel stayed open');
    await ui.act(async () => {
      h.emit({ kind: 'compact_progress', missionId: 'm1', operationId: 'op-1', mode: 'native', phase: 'compacting', targetMissionId: null, error: null, at: 2000 });
    });
    await ui.until(() => !!document.querySelector('[data-compact-phase="compacting"]'), 'the compacting step');
    assert.match(document.body.textContent ?? '', /Compacting the conversation/);
    await ui.act(async () => {
      h.emit({ kind: 'compact_progress', missionId: 'm1', operationId: 'op-1', mode: 'native', phase: 'done', targetMissionId: 'm1', error: null, at: 3000 });
    });
    await ui.until(() => !!document.querySelector('[data-compact-phase="done"]'), 'the end');
    assert.match(document.body.textContent ?? '', /Conversation compacted/);
    assert.ok(!document.querySelector('[data-busy="true"]'), 'the ring stops');
  } finally {
    await ui.unmount();
  }
});

test('409 turn_in_flight: the panel says to wait for the reply', async () => {
  const h = storeHarness(() => new Response(JSON.stringify({ error: 'busy', code: 'turn_in_flight' }), { status: 409 }));
  const store = await h.make();
  const ui = await mount({ store, nativeCompact: false });
  try {
    await ui.openPanel();
    assert.match(document.querySelector('[data-compact-hint]')?.textContent ?? '', /new conversation/, 'fork: a hint says a new conversation opens');
    const action = document.querySelector<HTMLElement>('[data-compact-action]');
    assert.ok(action, 'the primary action is offered');
    await ui.key(action, 'Enter');
    await ui.until(() => !!document.querySelector('[role="alert"]'), 'the refusal to show');
    assert.match(document.querySelector('[role="alert"]')!.textContent ?? '', /once the reply is over/);
    assert.ok(!document.querySelector('[data-busy="true"]'), 'no spinner left behind');
  } finally {
    await ui.unmount();
  }
});

test('a native compaction is not offered while the agent answers', async () => {
  const ui = await mount({ nativeCompact: true, thinking: true });
  try {
    await ui.openPanel();
    assert.match(document.querySelector('[data-compact-hint]')?.textContent ?? '', /once the reply is over/, 'the panel says why it waits');
    const action = document.querySelector<HTMLElement>('[data-compact-action]');
    assert.ok(action, 'the action is still shown');
    assert.equal(action.getAttribute('data-disabled'), '');
  } finally {
    await ui.unmount();
  }
});

test('Cancel on the compaction dialog leaves the page clickable', async () => {
  const ui = await mount();
  try {
    await ui.openPanel();
    const compact = () => ui.item(/Another model/);
    await ui.until(() => !!compact(), 'the gauge panel to offer "Another model…"');
    await ui.key(compact()!, 'Enter');
    await ui.until(() => !!document.getElementById('cancel'), 'the compaction dialog to mount');
    assert.equal(ui.state.open, true, 'the item opened the dialog');
    assert.ok(document.querySelector('[role="dialog"]'), 'the dialog is mounted');

    await ui.click(document.getElementById('cancel')!);
    await ui.until(() => !document.querySelector('[role="dialog"]'), 'the dialog to unmount');
    // The defect left its marks after the unmount, in a later turn: give the
    // closing menu and dialog one more turn before reading them.
    await ui.until(() => true, 'the closing layers to clean up');
    assert.equal(ui.state.open, false, 'Cancel closed the dialog');
    assert.ok(!document.querySelector('[role="dialog"]'), 'no dialog left behind');
    assert.notEqual(document.body.style.pointerEvents, 'none', 'body still ignores the pointer');
    assert.ok(!document.querySelector('[data-radix-focus-guard]'), 'no focus guard left behind');
  } finally {
    await ui.unmount();
  }
});
