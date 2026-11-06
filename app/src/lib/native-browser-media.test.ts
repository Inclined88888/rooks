import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserCommand } from './native-browser';

test('WebRTC uses receive-only tracks, restarts after tab or viewport changes, and exposes lease failure', async (context) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://timon.example', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLMediaElement', 'Node']) install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react'); install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { useBrowserMedia } = await import('../hooks/use-browser-media');
  const transceivers: Array<{ kind: string; direction: string }> = [];
  const actions: Array<{ action: string; mediaId?: unknown }> = [];
  let nextId = 0;
  let denyRenew = false;
  let closed = 0;
  class FakePeer extends dom.window.EventTarget {
    iceGatheringState = 'complete'; connectionState = 'new';
    localDescription: { toJSON: () => unknown } | null = null;
    ontrack: ((event: { track: object }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    addTransceiver(kind: string, init: { direction: string }) { transceivers.push({ kind, direction: init.direction }); }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription(offer: unknown) { this.localDescription = { toJSON: () => offer }; }
    async setRemoteDescription() { this.ontrack?.({ track: {} }); this.connectionState = 'connected'; this.dispatchEvent(new dom.window.Event('connectionstatechange')); }
    async getStats() { return new Map([['video', { type: 'inbound-rtp', kind: 'video', bytesReceived: 12000, framesPerSecond: 30 }]]); }
    close() { this.connectionState = 'closed'; closed++; }
  }
  install('RTCPeerConnection', FakePeer); install('MediaStream', class { addTrack() {} });
  dom.window.HTMLMediaElement.prototype.play = async function () { Object.defineProperty(this, 'readyState', { configurable: true, value: 4 }); Object.defineProperty(this, 'videoWidth', { configurable: true, value: 1366 }); };
  const command: BrowserCommand = async <T>(action: string, data?: Record<string, unknown>) => {
    actions.push({ action, mediaId: data?.mediaId });
    if (action === 'mediaOffer') return { mediaId: `media-${++nextId}`, answer: { type: 'answer', sdp: 'v=0' } } as T;
    if (action === 'mediaRenew' && denyRenew) throw new Error('Media authorization expired');
    if (action === 'mediaStart') assert.fail('healthy RTC or expired authorization must not silently start another transport');
    return {} as T;
  };
  function Probe({ tab, viewport = '390:700:true' }: { tab: string; viewport?: string }) {
    const ref = React.useRef<HTMLVideoElement>(null);
    const state = useBrowserMedia(ref, true, 'profile', tab, true, command, viewport);
    return React.createElement('div', null, React.createElement('video', { ref }), React.createElement('output', null, `${state.phase}:${state.transport}:${state.error ?? ''}`));
  }
  const root = createRoot(document.getElementById('root')!);
  context.mock.timers.enable({ apis: ['setInterval'] });
  try {
    await React.act(async () => root.render(React.createElement(Probe, { tab: 'tab-one' })));
    assert.equal(document.querySelector('output')!.textContent, 'live:webrtc:');
    assert.deepEqual(transceivers.slice(0, 2), [{ kind: 'video', direction: 'recvonly' }, { kind: 'audio', direction: 'recvonly' }]);
    await React.act(async () => root.render(React.createElement(Probe, { tab: 'tab-two' })));
    assert.ok(actions.findIndex((item) => item.action === 'mediaStop' && item.mediaId === 'media-1') < actions.findIndex((item, index) => index > 0 && item.action === 'mediaOffer'), 'old media closes before next offer');
    assert.ok(closed >= 1);
    const offersBeforeResize = actions.filter((item) => item.action === 'mediaOffer').length;
    await React.act(async () => root.render(React.createElement(Probe, { tab: 'tab-two', viewport: '1366:768:false' })));
    assert.equal(actions.filter((item) => item.action === 'mediaOffer').length, offersBeforeResize + 1, 'changing the capture viewport renegotiates the stream');
    assert.ok(actions.findIndex((item) => item.action === 'mediaStop' && item.mediaId === 'media-2') < actions.map((item) => item.action).lastIndexOf('mediaOffer'), 'the old capture stops before restarting at the new viewport');
    denyRenew = true;
    await React.act(async () => { context.mock.timers.tick(20_000); });
    assert.match(document.querySelector('output')!.textContent!, /^error:webrtc:Media authorization expired/);
    assert.ok(actions.some((item) => item.action === 'mediaStop' && item.mediaId === 'media-3'));
  } finally {
    await React.act(async () => root.unmount()); context.mock.timers.reset();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});

test('failed WebRTC closes before HTTPS video, appends ordered media, and prunes old playback data', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://timon.example', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLMediaElement', 'Node']) install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react'); install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { useBrowserMedia } = await import('../hooks/use-browser-media');
  const actions: string[] = [];
  const appended: number[] = [];
  const removed: Array<[number, number]> = [];
  let seq = 0;
  let releaseRead: () => void = () => {};
  class FakePeer extends dom.window.EventTarget {
    iceGatheringState = 'complete'; connectionState = 'new'; localDescription = { toJSON: () => ({ type: 'offer', sdp: 'v=0' }) };
    addTransceiver() {} async createOffer() { return this.localDescription; } async setLocalDescription() {}
    async setRemoteDescription() { throw new Error('ICE route unavailable'); } close() { this.connectionState = 'closed'; }
  }
  class BufferSource extends dom.window.EventTarget {
    end = 0; start = 0;
    buffered = { get length() { return 1; }, start: () => this.start, end: () => this.end };
    appendBuffer(bytes: Uint8Array) { appended.push(bytes[0]!); this.end++; queueMicrotask(() => this.dispatchEvent(new dom.window.Event('updateend'))); }
    remove(start: number, end: number) { removed.push([start, end]); this.start = end; queueMicrotask(() => this.dispatchEvent(new dom.window.Event('updateend'))); }
  }
  class Source extends dom.window.EventTarget {
    readyState = 'closed'; static isTypeSupported() { return true; }
    addSourceBuffer() { return new BufferSource(); }
  }
  install('RTCPeerConnection', FakePeer); install('MediaStream', class { addTrack() {} }); install('MediaSource', Source);
  const oldCreate = URL.createObjectURL; const oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((source: Source) => { queueMicrotask(() => { source.readyState = 'open'; source.dispatchEvent(new dom.window.Event('sourceopen')); }); return 'blob:video'; }) as unknown as typeof URL.createObjectURL;
  const revoked: string[] = []; URL.revokeObjectURL = (url) => { revoked.push(url); };
  dom.window.HTMLMediaElement.prototype.play = async () => {};
  const command: BrowserCommand = async <T>(action: string, data?: Record<string, unknown>) => {
    actions.push(action);
    if (action === 'mediaOffer') return { mediaId: 'rtc', answer: { type: 'answer', sdp: 'v=0' } } as T;
    if (action === 'mediaStop') { assert.ok(['rtc', 'https'].includes(String(data?.mediaId))); return {} as T; }
    if (action === 'mediaStart') { assert.ok(actions.indexOf('mediaStop') < actions.lastIndexOf('mediaStart')); assert.ok((data?.supportedMimeTypes as string[]).includes('video/mp4;codecs=avc1.42E01E,mp4a.40.2')); return { mediaId: 'https', mimeType: 'video/webm;codecs=vp8,opus' } as T; }
    if (action === 'mediaRead') {
      if (seq < 22) return { sequence: seq, data: Buffer.from([seq++]).toString('base64'), eof: false } as T;
      await new Promise<void>((resolve) => { releaseRead = resolve; }); return { eof: true } as T;
    }
    if (action === 'screenshot') assert.fail('encoded playback never silently chooses screenshots');
    return {} as T;
  };
  function Probe() { const ref = React.useRef<HTMLVideoElement>(null); const state = useBrowserMedia(ref, true, 'profile', 'tab', true, command, 0); return React.createElement('div', null, React.createElement('video', { ref }), React.createElement('output', null, `${state.phase}:${state.transport}`)); }
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => { root.render(React.createElement(Probe)); });
    assert.equal(document.querySelector('output')!.textContent, 'live:https');
    assert.deepEqual(appended, Array.from({ length: 22 }, (_, index) => index));
    assert.ok(removed.length > 0, 'old media is pruned before accumulating without limit');
    assert.ok(removed.every(([start, end]) => end > start));
  } finally {
    await React.act(async () => { root.unmount(); releaseRead(); });
    assert.deepEqual(revoked, ['blob:video']);
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    dom.window.close();
  }
});
