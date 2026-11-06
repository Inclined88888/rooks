import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskLink } from './task-links-badge';

/**
 * TIM-0078: the tasks that block a deletion must be readable without a mouse.
 * The badge is a button (focusable, Enter/Space, a tap) that unfolds the list
 * on the card, and keeps the card's own click (opening the task) out of it.
 */

async function withDom<T>(run: (react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  try {
    return await run(React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

const BOARD = new Map([['review-aaaaaaaa-1111', { title: 'review: fix X', status: 'BLOCKED' }]]);
const LINKS: TaskLink[] = [
  { id: 'review-aaaaaaaa-1111', kind: 'chain' },
  { id: 'gone-bbbbbbbb-2222', kind: 'dep' },
];

async function renderBadge(run: (host: HTMLElement, cardClicks: () => number, react: typeof import('react')) => Promise<void>) {
  await withDom(async (React) => {
    const { createRoot } = await import('react-dom/client');
    const { TaskLinksBadge } = await import('./task-links-badge');
    const host = document.getElementById('root')!;
    const root = createRoot(host);
    let clicks = 0;
    try {
      await React.act(async () => {
        root.render(React.createElement('article', { onClick: () => { clicks += 1; } },
          React.createElement(TaskLinksBadge, { label: 'chain of 2', header: 'Tasks that depend on this one:', links: LINKS, byId: BOARD, tone: 'chain' })));
      });
      await run(host, () => clicks, React);
    } finally {
      await React.act(async () => { root.unmount(); });
    }
  });
}

test('the badge is a focusable button that discloses the linked tasks, without opening the card', async () => {
  await renderBadge(async (host, cardClicks, React) => {
    const button = host.querySelector('button')!;
    assert.ok(button, 'a real button, reachable with Tab');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.ok(!host.querySelector('[role="region"]'), 'folded by default');
    // jsdom has no layout: the 24×24 minimum target (WCAG 2.2) is held by the
    // classes that size the button itself, not the small visual badge inside.
    const classes = button.className.split(/\s+/);
    for (const cls of ['inline-flex', 'min-h-6', 'min-w-6']) {
      assert.ok(classes.includes(cls), `the hit box keeps ${cls}`);
    }
    assert.equal(button.textContent, 'chain of 2');

    button.focus();
    assert.equal(document.activeElement, button);
    // Enter and Space on a native button fire `click`: one path for keyboard, mouse and touch.
    await React.act(async () => { button.click(); });

    assert.equal(button.getAttribute('aria-expanded'), 'true');
    const region = host.querySelector('[role="region"]')!;
    assert.ok(region, 'the list unfolds');
    assert.equal(button.getAttribute('aria-controls'), region.id);
    assert.equal(region.getAttribute('aria-label'), 'Tasks that depend on this one:');
    const items = Array.from(region.querySelectorAll('li')).map((li) => li.textContent ?? '');
    assert.equal(items.length, 2);
    assert.match(items[0] ?? '', /#review-a.*review: fix X.*BLOCKED.*verification chain/);
    assert.match(items[1] ?? '', /#gone-bbb.*not on the board/);

    await React.act(async () => { (region as HTMLElement).click(); });
    assert.equal(cardClicks(), 0, 'neither the badge nor its list opens the task');

    await React.act(async () => { button.click(); });
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.ok(!host.querySelector('[role="region"]'), 'folded again');
  });
});
