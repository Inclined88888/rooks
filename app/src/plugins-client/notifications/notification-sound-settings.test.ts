import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The settings block: one row per event (switch, sound, listen), one volume.
 * Every change is a write of the account's `notifications.sounds` row.
 */

type Call = { url: string; method: string; body?: string };

async function withSettings(
  stored: unknown,
  run: (host: HTMLElement, react: typeof import('react'), calls: Call[], started: number[]) => Promise<void>,
): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const started: number[] = [];
  class FakeAudioContext {
    state = 'suspended';
    sampleRate = 22050;
    destination = {};
    resume() { this.state = 'running'; return Promise.resolve(); }
    createBuffer(_channels: number, length: number) {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    }
    createGain() { return { gain: { value: 0 }, connect: (next: unknown) => next }; }
    createBufferSource() {
      return {
        buffer: null,
        connect: (next: unknown) => next,
        start: () => { started.push(1); },
      };
    }
  }
  (dom.window as unknown as Record<string, unknown>).AudioContext = FakeAudioContext;
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'KeyboardEvent', 'PointerEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);

  const calls: Call[] = [];
  let row: unknown = stored;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: input, method, body: init?.body });
    if (method === 'PUT') row = (JSON.parse(init!.body!) as { layout: unknown }).layout;
    return new Response(JSON.stringify({ layout: row }), { status: 200 });
  }) as unknown as typeof fetch;

  const { resetNotificationSoundPrefsForTest } = await import('@/hooks/use-notification-sound-prefs');
  const { resetNotificationSoundPlayerForTest } = await import('@/lib/notification-sound-player');
  resetNotificationSoundPrefsForTest();
  resetNotificationSoundPlayerForTest();
  const { createRoot } = await import('react-dom/client');
  const { NotificationSoundSettings } = await import('./notification-sound-settings');
  const host = document.getElementById('root')!;
  const root = createRoot(host);
  try {
    await React.act(async () => { root.render(React.createElement(NotificationSoundSettings)); });
    await React.act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
    await run(host, React, calls, started);
  } finally {
    await React.act(async () => { root.unmount(); });
    globalThis.fetch = savedFetch;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

function lastWrite(calls: Call[]): { volume: number; events: Record<string, { enabled: boolean; sound: string }> } {
  const put = calls.filter((c) => c.method === 'PUT').at(-1);
  assert.ok(put, 'a write was sent');
  assert.match(put.url, /scope=notifications\.sounds/);
  return (JSON.parse(put.body!) as { layout: { volume: number; events: Record<string, { enabled: boolean; sound: string }> } }).layout;
}

test('one row per event, read from the account\'s stored settings', async () => {
  await withSettings({ v: 1, volume: 40, events: { taskBlocked: { enabled: false, sound: 'pop' } } }, async (host, _react, calls) => {
    assert.ok(calls.some((c) => c.method === 'GET' && /scope=notifications\.sounds/.test(c.url)));
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-sound-event]'), (r) => r.dataset.soundEvent);
    assert.deepEqual(rows, ['taskStarted', 'taskDone', 'taskBlocked', 'approval', 'missionDone']);
    const blocked = host.querySelector('[data-sound-event="taskBlocked"]')!;
    assert.equal(blocked.querySelector('[role="switch"]')!.getAttribute('aria-checked'), 'false');
    assert.equal(blocked.querySelector('select')!.value, 'pop');
    assert.equal(blocked.querySelector('select')!.disabled, true, 'the sound of a disabled event is not chosen');
    assert.equal(host.querySelector<HTMLInputElement>('input[type="range"]')!.value, '40');
  });
});

test('switching an event off and choosing a sound are stored', async () => {
  await withSettings(null, async (host, React, calls) => {
    const done = host.querySelector('[data-sound-event="taskDone"]')!;
    await React.act(async () => { done.querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
    assert.equal(lastWrite(calls).events.taskDone!.enabled, false);

    const select = host.querySelector<HTMLSelectElement>('[data-sound-event="approval"] select')!;
    await React.act(async () => {
      select.value = 'bell';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.equal(lastWrite(calls).events.approval!.sound, 'bell');
    assert.equal(lastWrite(calls).events.taskDone!.enabled, false, 'the earlier change is kept');
  });
});

test('a task start is off, sound and toast, until switched on; each switch is its own', async () => {
  await withSettings(null, async (host, React, calls) => {
    const row = host.querySelector('[data-sound-event="taskStarted"]')!;
    const [sound, toast] = Array.from(row.querySelectorAll<HTMLButtonElement>('[role="switch"]'));
    assert.ok(sound && toast, 'a sound switch and a toast switch');
    assert.equal(sound.getAttribute('aria-checked'), 'false');
    assert.equal(toast.getAttribute('aria-checked'), 'false');
    assert.equal(host.querySelectorAll('[data-sound-toast]').length, 1, 'only a task start has a toast');

    await React.act(async () => { toast.click(); });
    const written = lastWrite(calls) as unknown as { taskStartedToast: boolean; events: Record<string, { enabled: boolean }> };
    assert.equal(written.taskStartedToast, true);
    assert.equal(written.events.taskStarted!.enabled, false, 'the toast does not switch the sound on');
  });
});

test('the volume is stored when the slider is released, not at every step', async () => {
  await withSettings(null, async (host, React, calls) => {
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await React.act(async () => {
      for (const v of ['50', '45', '30']) {
        setter.call(slider, v);
        slider.dispatchEvent(new window.Event('input', { bubbles: true }));
      }
    });
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
    await React.act(async () => { slider.dispatchEvent(new window.Event('blur')); slider.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
    assert.equal(lastWrite(calls).volume, 30);
  });
});

test('"listen" plays the chosen sound from the click, which unlocks the audio', async () => {
  await withSettings(null, async (host, React, _calls, started) => {
    const listen = host.querySelector<HTMLButtonElement>('[data-sound-preview="taskDone"]')!;
    assert.match(listen.getAttribute('aria-label') ?? '', /Chime/);
    await React.act(async () => { listen.click(); await Promise.resolve(); await Promise.resolve(); });
    assert.ok(started.includes(1), 'a buffer source was started');
  });
});
