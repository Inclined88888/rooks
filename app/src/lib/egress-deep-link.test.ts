/**
 * `/chat?mission=<id>&egress=1` (a new-host alert's link) opens the mission's
 * Network view beside the chat: once the workspace is there, only if the
 * missions module holds the content, and once per mission.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { IslandContent } from './island-tree';
import { waitUntil } from './test-wait';

test('the alert link opens the Network view once the workspace is announced', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?mission=m-1&egress=1', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Event']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const slots = await import('./plugin-host/slots');
  const bus = await import('./island-bus');
  const { useEgressDeepLink } = await import('./egress-deep-link');

  slots.resetSlotsForTests();
  slots.declareSlot('island.content', 'list');
  const opened: Array<{ content: IslandContent; edge: string }> = [];
  const handle = {
    open(content: IslandContent, edge: string) { opened.push({ content, edge }); return true; },
    activate() {},
    close() {},
  };

  function Probe({ missionId, requested }: { missionId: string | null; requested: boolean }) {
    useEgressDeepLink(missionId, requested);
    return null;
  }
  const root = createRoot(document.getElementById('root')!);
  const render = (missionId: string | null, requested: boolean) =>
    React.act(async () => root.render(React.createElement(Probe, { missionId, requested })));
  const flush = () => waitUntil(React.act, () => true, 'a tick');
  let withdraw = null as (() => void) | null;

  try {
    await suite.test('nothing opens before the workspace, nor without the content type', async () => {
      await render('m-1', true);
      await flush();
      assert.deepEqual(opened, []);
      withdraw = bus.announceIslandWorkspace(handle);
      await React.act(async () => bus.publishIslandTabs(handle, [], false));
      await flush();
      assert.deepEqual(opened, [], 'the missions module is off: no content to open');
    });

    await suite.test('the content registered, the view opens on the right, once', async () => {
      slots.register({ slot: 'island.content', pluginId: '@timon/missions', key: 'egress', island: { title: 'Network', parseParams: () => ({}) } }, () => null);
      await waitUntil(React.act, () => opened.length === 1, 'the open');
      assert.deepEqual(opened[0], { content: { type: '@timon/missions:egress', params: { missionId: 'm-1' } }, edge: 'right' });
      await render('m-1', true);
      await flush();
      assert.equal(opened.length, 1, 'a rerender does not open it again');
    });

    await suite.test('a chat without the link opens nothing; a narrow screen opens a tab', async () => {
      await render('m-2', false);
      await flush();
      assert.equal(opened.length, 1);
      await React.act(async () => bus.publishIslandTabs(handle, [], true));
      await render('m-2', true);
      await waitUntil(React.act, () => opened.length === 2, 'the narrow open');
      assert.equal(opened[1]!.edge, 'center');
    });
  } finally {
    await React.act(async () => root.unmount());
    withdraw?.();
    slots.resetSlotsForTests();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
