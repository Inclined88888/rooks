/**
 * `chat.media` is a boot slot (TODO #380): a replacement card registers when
 * the plugins load, before any media block is on screen, and keeps its place
 * while every block leaves and comes back. Run through the real loader.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const BLOCK = { type: 'media', file: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png', kind: 'image', mime: 'image/png', source: 'file' } as const;

async function installDom(plugins: unknown[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const win = dom.window;
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
    'KeyboardEvent', 'FocusEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? win : (win as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string) => {
    if (String(input) === '/api/ui/plugins') return Response.json({ plugins });
    return new Response(null, { status: 404 });
  });
  const React = await import('react');
  install('React', React);
  const { resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  const loader = await import('./plugin-host/loader');
  loader.resetClientPluginsForTests();
  // The product's card arrives with the bundled half of @timon/missions.
  const { ChatMediaCard } = await import('../components/chat/media-block');
  const { register } = await import('./plugin-host/slots');
  register({ slot: 'chat.media', pluginId: '@timon/missions', fallback: true }, ChatMediaCard);

  const { ChatMediaSlot } = await import('../components/chat/media-block');
  const { createRoot } = await import('react-dom/client');
  const render = async (count = 1) => {
    const host = document.createElement('div');
    document.getElementById('root')!.append(host);
    const root = createRoot(host);
    await React.act(async () => {
      root.render(React.createElement(React.Fragment, null, ...Array.from({ length: count }, (_, i) =>
        React.createElement(ChatMediaSlot, { key: i, block: BLOCK, missionId: 'm-1' }))));
    });
    return async () => { await React.act(async () => { root.unmount(); }); host.remove(); };
  };
  return { win, React, render, loader };
}

test('a replacement loaded before any block keeps the slot while every block leaves and comes back', async () => {
  const { win, React, render, loader } = await installDom([
    { id: 'acme-media', state: 'active', client: { url: '/x', rev: '1', slots: ['chat.media'] } },
  ]);
  const { useChatMedia } = await import('../components/chat/media-block');
  const { slotEntries } = await import('./plugin-host/slots');
  const AcmeCard = () => React.createElement('p', { 'data-acme': '' }, useChatMedia()?.block.file);
  loader.setLoadClientModuleForTests(async () => ({
    apply(ctx) { ctx.slots.register({ slot: 'chat.media' }, AcmeCard); },
  }));
  const occupants = () => slotEntries('chat.media').map((e) => e.pluginId);
  try {
    // The real boot order: the plugins load before any block is on screen.
    await loader.syncClientPlugins();
    assert.deepEqual(occupants(), ['acme-media', '@timon/missions']);

    const closeTwo = await render(2);
    assert.equal(document.querySelectorAll('[data-acme]').length, 2);
    assert.ok(!document.querySelector('figure'), 'the product card steps aside');
    await closeTwo();
    assert.deepEqual(occupants(), ['acme-media', '@timon/missions'], 'the last block leaving collapses nothing');

    const closeOne = await render(1);
    assert.equal(document.querySelectorAll('[data-acme]').length, 1);
    await closeOne();
  } finally {
    loader.setLoadClientModuleForTests(null);
    loader.resetClientPluginsForTests();
    win.close();
  }
});

test('without a replacement, the product card occupies the boot slot', async () => {
  const { win, render } = await installDom();
  const { slotEntries, slotKind } = await import('./plugin-host/slots');
  assert.equal(slotKind('chat.media'), 'single', 'declared at boot, before any block');
  assert.deepEqual(slotEntries('chat.media').map((e) => e.pluginId), ['@timon/missions']);
  const close = await render(1);
  assert.ok(document.querySelector('figure.chat-media'));
  await close();
  assert.equal(slotKind('chat.media'), 'single', 'the last block leaving keeps the slot');
  win.close();
});
