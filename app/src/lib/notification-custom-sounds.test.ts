import assert from 'node:assert/strict';
import test from 'node:test';
import { CUSTOM_MAX_BYTES, importCustomSound } from './notification-custom-sounds';

test('a file over the bound is refused before anything is decoded or sent', async () => {
  let sent = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { sent = true; return new Response(null); }) as typeof fetch;
  try {
    const big = new File([new Uint8Array(CUSTOM_MAX_BYTES + 1)], 'long.wav', { type: 'audio/wav' });
    assert.deepEqual(await importCustomSound('taskDone', big), { ok: false, reason: 'too_large' });
    assert.equal(sent, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('without an audio context nothing is sent either', async () => {
  let sent = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { sent = true; return new Response(null); }) as typeof fetch;
  try {
    const file = new File([new Uint8Array(64)], 'ding.wav', { type: 'audio/wav' });
    const out = await importCustomSound('approval', file);
    assert.equal(out.ok, false);
    assert.equal(sent, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
