/** "Copy" on a notification: the whole text goes to the clipboard and the click does not follow the card's link (TODO #270). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';

test('the copied text is the title, then the whole body', async () => {
  const { notificationCopyText } = await import('./copy-notification-button');
  assert.equal(notificationCopyText({ title: 'Build failed', body: 'line 1\nline 2' }), 'Build failed\n\nline 1\nline 2');
  assert.equal(notificationCopyText({ title: 'Done', body: null }), 'Done');
});

test('the button copies and does not trigger the link around it', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'Event'] as const) {
    Object.defineProperty(globalThis, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
  const written: string[] = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (t: string) => { written.push(t); } }, configurable: true });

  const React = await import('react');
  Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const { CopyNotificationButton } = await import('./copy-notification-button');
  const root = createRoot(document.getElementById('root')!);
  let followed = false;
  const link = React.createElement(
    'a',
    { href: '#x', onClick: () => { followed = true; } },
    React.createElement(CopyNotificationButton, { notification: { title: 'Error', body: 'stack trace' } }),
  );
  try {
    await React.act(async () => { root.render(link); });
    const button = document.querySelector<HTMLElement>('button');
    if (!button) assert.fail('no copy button rendered');
    assert.equal(button.getAttribute('aria-label'), 'Copy');
    await React.act(async () => { button.click(); });
    await waitUntil(React.act, () => written.length > 0, 'the notification to be copied');
    assert.deepEqual(written, ['Error\n\nstack trace']);
    assert.equal(followed, false, 'the click must not reach the link');
  } finally {
    await React.act(async () => { root.unmount(); });
  }
});
