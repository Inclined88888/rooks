/**
 * The record button and its pill (`@rooks/browser-recording`, TODO #461):
 * start and stop go through the plugin's daemon routes, never a raw
 * `command()`; the pill shows to every viewer, Stop to the owner only; and the
 * half acts only because it declares `browser:control`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { browserRecordingDom, status } from '@/lib/browser-recording-test-dom';

const META = {
  id: 'br-00000000-0000-4000-8000-000000000001', profileId: 'p1', title: 'shop.example', startUrl: 'https://shop.example/',
  steps: 3, flagged: 1, truncated: false, stoppedReason: 'user', createdAt: 1, updatedAt: 1, status: 'draft',
  learnMissionId: null, stepsAvailable: true,
};

test('the declared half records through the plugin routes, and Stop opens the review of the saved recording', async () => {
  const ui = await browserRecordingDom({
    owner: true,
    route: (call) => {
      if (call.url.endsWith('/p1/recording/start')) return Response.json({ recording: { active: true, steps: 1 } });
      if (call.url.endsWith('/p1/recording/stop')) return Response.json({ recording: META });
      return undefined;
    },
  });
  try {
    await ui.until(() => !!ui.button('Record'), 'the owner to get the record button');
    const record = ui.button('Record');
    assert.ok(record?.closest('[data-browser-chrome="controls"]'), 'in the address bar');
    assert.equal(record?.disabled, false);
    await ui.click(record);
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/recording/start')), 'the start route');
    const start = ui.calls.find((call) => call.url.endsWith('/recording/start'));
    assert.deepEqual([start?.method, start?.url, start?.body], ['POST', '/api/ui/native-browser/p1/recording/start', {}]);

    await ui.browse({ status: status({ active: true, steps: 3 }) });
    const pill = () => document.querySelector('[data-browser-recording]');
    await ui.until(() => pill()?.getAttribute('data-browser-recording') === 'active', 'the pill');
    assert.match(pill()?.textContent ?? '', /Recording · 3 steps/);
    assert.equal(pill()?.getAttribute('role'), 'status');
    assert.ok(!ui.button('Record'), 'no record button while recording');

    await ui.click(ui.button('Stop'));
    await ui.until(() => ui.drawers.includes('recording-review'), 'the review drawer to be asked for');
    const stop = ui.calls.find((call) => call.url.endsWith('/recording/stop'));
    assert.deepEqual([stop?.method, stop?.body], ['POST', {}]);
    const { browserRecordingState } = await import('@/lib/browser-recording');
    assert.equal(browserRecordingState('p1').selectedId, META.id, 'the review opens on the recording the daemon saved');
    assert.equal(ui.calls.some((call) => /command$/.test(call.url)), false, 'never a raw command');
  } finally { await ui.cleanup(); }
});

test('a recording that ended on its own is collected by Review', async () => {
  const ui = await browserRecordingDom({ owner: true, route: (call) => (call.url.endsWith('/recording/stop') ? Response.json({ recording: { ...META, stoppedReason: 'idle' } }) : undefined) });
  try {
    await ui.browse({ status: status({ active: false, steps: 12, stoppedReason: 'idle' }) });
    await ui.until(() => document.querySelector('[data-browser-recording]')?.getAttribute('data-browser-recording') === 'ended', 'the ended pill');
    assert.match(document.querySelector('[data-browser-recording]')?.textContent ?? '', /Recording ended · 12 steps/);
    assert.ok(!ui.button('Record'), 'a finished recording is collected before another one starts');
    await ui.click(ui.button('Review'));
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/recording/stop')), 'the collection');
  } finally { await ui.cleanup(); }
});

test('a spectator who does not own the profile sees the pill, but neither Stop nor Record', async () => {
  const ui = await browserRecordingDom({ owner: false });
  try {
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/p1/recordings')), 'the owner check');
    await ui.browse({ status: status({ active: true, steps: 2 }, false), controlled: false });
    await ui.until(() => !!document.querySelector('[data-browser-recording="active"]'), 'the pill for a spectator');
    assert.ok(!ui.button('Stop'), 'stopping is the owner\'s');
    await ui.browse({ status: status(undefined, false), controlled: false });
    await ui.until(() => !document.querySelector('[data-browser-recording]'), 'the pill to go');
    assert.ok(!ui.button('Record'));
  } finally { await ui.cleanup(); }
});

test('the owner without the control lease (another device holds it) cannot start, but can stop', async () => {
  const ui = await browserRecordingDom({ owner: true, route: (call) => (call.url.endsWith('/recording/stop') ? Response.json({ recording: META }) : undefined) });
  try {
    await ui.browse({ status: status(undefined, false), controlled: false });
    await ui.until(() => !!ui.button('Record'), 'the record button');
    assert.equal(ui.button('Record')?.disabled, true);
    assert.match(ui.button('Record')?.title ?? '', /another device holds it/);
    await ui.browse({ status: status({ active: true, steps: 1 }, false), controlled: false });
    await ui.click(ui.button('Stop'));
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/recording/stop')), 'the owner\'s stop from a spectator device');
  } finally { await ui.cleanup(); }
});

test('without browser:control in its declaration, the half cannot record: nothing reaches the daemon', async () => {
  const ui = await browserRecordingDom({ owner: true, plugin: (base) => ({ ...base, permissions: [] }) });
  try {
    await ui.until(() => !!ui.button('Record'), 'the record button');
    assert.equal(ui.button('Record')?.disabled, true, 'nothing to press');
    await ui.browse({ status: status({ active: true, steps: 1 }) });
    await ui.click(ui.button('Stop'));
    await ui.until(() => !!document.querySelector('[role="alert"]'), 'the refusal');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /plugin `@rooks\/browser-recording`: .*`browser:control`/);
    assert.equal(ui.calls.some((call) => call.method !== 'GET'), false, 'a refused action never reaches the daemon');
  } finally { await ui.cleanup(); }
});

test('a third-party half gets useBrowserRecording through `@rooks/ui` (client API 13)', async () => {
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  const { useBrowserRecording } = await import('@/hooks/use-browser-recording');
  const { PLATFORM_MODULE_SOURCES, platformModuleExports } = await import('@/lib/plugin-host/platform-modules');
  assert.equal(UI_KIT.useBrowserRecording, useBrowserRecording);
  assert.ok(platformModuleExports('ui.js').includes('useBrowserRecording'));
  assert.match(PLATFORM_MODULE_SOURCES['ui.js'] ?? '', /useBrowserRecording=u\.useBrowserRecording/);
});
