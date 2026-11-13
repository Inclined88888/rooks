import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActiveAgent } from '@/lib/agent-state';
import type { AgentIdentity } from '@/components/agent-avatar';

/**
 * The maintainer's request: in the top bar's agent tabs, close goes top right, pin bottom right, the
 * state dot on the left becomes the agent's avatar, and the "working" pulse
 * plays AROUND the avatar. The state word and the timer stay.
 */

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  try {
    return await run(dom as unknown as Dom, React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

const FACE: AgentIdentity = { name: 'rooks.main', accent: '#22c55e', iconUrl: '/api/uploads/main.png', fallback: 't', roleKey: null, known: true };

// One clock for the fixture and the render: a slow run must not move the timer.
const NOW = Date.now();

function agent(state: ActiveAgent['state']): ActiveAgent {
  return { name: 'rooks.main', state, mission_id: 'm1', at: NOW - 792_000, pending_count: 0, project: null };
}

async function renderChip(a: ActiveAgent, opts: { pinned?: boolean; dismissable?: boolean }, run: (host: HTMLElement) => void | Promise<void>) {
  await withDom(async (_dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { AgentChip } = await import('@/plugins-client/working-agents/agent-strip');
    const host = document.getElementById('root')!;
    const root = createRoot(host);
    try {
      await React.act(async () => {
        root.render(React.createElement(AgentChip, {
          agent: a, identity: FACE, highlighted: false, now: NOW, pinned: opts.pinned ?? false,
          onTogglePin: () => {}, onDismiss: opts.dismissable === false ? null : () => {},
        }));
      });
      await run(host);
    } finally {
      await React.act(async () => { root.unmount(); });
    }
  });
}

test('the tab shows the agent avatar where the state dot was, with the state word and timer', async () => {
  await renderChip(agent('done'), {}, (host) => {
    const link = host.querySelector('a')!;
    const avatar = link.querySelector('[data-chip-avatar]')!;
    assert.ok(avatar, 'an avatar leads the tab');
    assert.equal(link.firstElementChild, avatar);
    assert.ok(avatar.querySelector('img[src="/api/uploads/main.png"]'), 'the agent picture');
    assert.match(link.textContent ?? '', /rooks\.main/);
    assert.match(link.textContent ?? '', /done/);
    assert.match(link.textContent ?? '', /13m12s/);
    assert.ok(!avatar.querySelector('[data-chip-pulse]'), 'no pulse when the agent is not working');
  });
});

test('a working agent pulses around its avatar, never under reduced motion', async () => {
  await renderChip(agent('thinking'), {}, (host) => {
    const pulse = host.querySelector('[data-chip-avatar] [data-chip-pulse]')!;
    assert.ok(pulse, 'the pulse wraps the avatar');
    assert.match(pulse.className, /motion-safe:animate-/);
    assert.match(pulse.className, /motion-reduce:hidden/);
  });
});

test('close sits at the top of the right edge, pin at the bottom', async () => {
  await renderChip(agent('thinking'), {}, (host) => {
    const actions = host.querySelector('[data-chip-actions]')!;
    assert.ok(actions);
    assert.equal(actions.previousElementSibling?.tagName, 'A', 'the column follows the link: right edge');
    assert.ok(actions.firstElementChild?.hasAttribute('data-chip-close'), 'close first (top)');
    assert.ok(actions.lastElementChild?.hasAttribute('data-chip-pin'), 'pin last (bottom)');
    assert.match(actions.className, /flex-col/);
    assert.match(actions.className, /justify-between/);
  });
});

test('a tab that cannot be dismissed keeps its pin at the bottom', async () => {
  await renderChip(agent('idle'), { pinned: true, dismissable: false }, (host) => {
    const actions = host.querySelector('[data-chip-actions]')!;
    assert.ok(!actions.querySelector('[data-chip-close]'));
    assert.equal(actions.children.length, 2, 'a spacer holds the top corner');
    assert.ok(actions.lastElementChild?.hasAttribute('data-chip-pin'));
    assert.equal(actions.lastElementChild?.getAttribute('aria-pressed'), 'true');
  });
});
