/**
 * The dictation bench of `@timon-ai/sdk/testing` (API 14, TODO #484) tested on
 * itself: an engine that breaks the contract must FAIL the checks a third party
 * runs, each for its own reason — a bench that passes everything protects no
 * one. Refusals first, then the fake engine that passes them all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DictationEngine, DictationEvent, DictationSession, DictationStartOptions } from '../../../packages/sdk/src/dictation.js';

const kit = await import('../../../packages/sdk/src/testing/index.js');
const {
  chunkPcm, concatPcm, createFakeDictationEngine, DICTATION_SAMPLE_RATE, dictationEngineChecks, dictationEngineProblem,
  dictationEventProblem, fakeUtterance, pcmToWav, readWavPcm, runDictation, silencePcm, speechLikePcm,
} = kit;

/** An engine built from the fake, with one behaviour swapped for a broken one. */
function brokenEngine(
  patch: (session: DictationSession, emit: (e: DictationEvent) => void, opts: DictationStartOptions) => Partial<DictationSession>,
  base: Partial<DictationEngine> = {},
): DictationEngine {
  const fake = createFakeDictationEngine();
  return {
    ...fake,
    ...base,
    async start(opts) {
      const session = await fake.start(opts);
      return { ...session, ...patch(session, opts.onEvent, opts) };
    },
  };
}

/** Runs the named check of the bench, returning its error message or `null` when it passed. */
async function outcome(engine: DictationEngine, name: RegExp, expectation: Parameters<typeof dictationEngineChecks>[1] = {}): Promise<string | null> {
  const check = dictationEngineChecks(engine, { run: { settleMs: 20 }, ...expectation }).find((c) => name.test(c.name));
  assert.ok(check, `no check matches ${name}`);
  try { await check.run(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
}

// ── Refusals ─────────────────────────────────────────────────────────────────

test('the event guard drops what the product would drop', () => {
  assert.match(dictationEventProblem(null) ?? '', /object/);
  assert.match(dictationEventProblem({ type: 'transcript', text: 'x' }) ?? '', /unknown event type/);
  assert.match(dictationEventProblem({ type: 'final' }) ?? '', /string `text`/);
  assert.match(dictationEventProblem({ type: 'partial', text: 42 }) ?? '', /string `text`/);
  assert.match(dictationEventProblem({ type: 'final', text: 'x'.repeat(20_001) }) ?? '', /20001 characters/);
  assert.match(dictationEventProblem({ type: 'error', code: 'oops', message: 'm', fatal: true }) ?? '', /unknown error code/);
  assert.match(dictationEventProblem({ type: 'error', code: 'busy', message: 'm' }) ?? '', /boolean `fatal`/);
  assert.equal(dictationEventProblem({ type: 'final', text: 'x'.repeat(20_000) }), null);
  assert.equal(dictationEventProblem({ type: 'error', code: 'network', message: 'offline', fatal: false }), null);
  assert.equal(dictationEventProblem({ type: 'stopped' }), null);
});

test('the declaration check refuses what register() would refuse', () => {
  const fake = createFakeDictationEngine();
  const declared = (patch: Partial<DictationEngine>) => dictationEngineProblem({ ...fake, ...patch });
  assert.match(declared({ id: 'Acme Whisper' }) ?? '', /invalid engine id/);
  assert.match(declared({ id: '../x' }) ?? '', /invalid engine id/);
  assert.match(declared({ label: '  ' }) ?? '', /label/);
  assert.match(declared({ languages: { codes: ['fr-FR'], mode: 'forced' } }) ?? '', /primary subtag/);
  assert.match(declared({ languages: { codes: [], mode: 'required' } }) ?? '', /must list the codes/);
  assert.match(declared({ languages: { codes: [], mode: 'always' as 'auto' } }) ?? '', /languages.mode/);
  assert.match(declared({ interim: 'sometimes' as 'live' }) ?? '', /interim/);
  assert.equal(declared({}), null);
});

test('the manifest check refuses an engine id the manifest does not declare', async () => {
  const manifest = { timon: { dictation: { engines: [{ id: 'other-engine', runtime: 'page', egress: 'none' }] } } };
  assert.match(await outcome(createFakeDictationEngine(), /declares an id/, { manifest }) ?? '', /not declared in the manifest/);
  assert.match(await outcome(createFakeDictationEngine(), /declares an id/, { manifest: { timon: {} } }) ?? '', /no `timon.dictation.engines`/);
});

test('an engine that emits after `stopped` fails the dictation check', async () => {
  const engine = brokenEngine((session, emit) => ({
    async stop() { await session.stop(); emit({ type: 'final', text: 'late' }); },
  }));
  assert.match(await outcome(engine, /exactly one `stopped`/) ?? '', /after `stopped`/);
});

test('an engine that never emits `stopped` fails the dictation check', async () => {
  const engine = brokenEngine((_session, emit) => ({ async stop() { emit({ type: 'final', text: 'done' }); } }));
  assert.match(await outcome(engine, /exactly one `stopped`/) ?? '', /no `stopped` event/);
});

test('a `final` after stop() resolved fails: stop() resolves after the last final', async () => {
  const engine = brokenEngine((_session, emit) => ({
    async stop() { setTimeout(() => { emit({ type: 'final', text: 'late' }); emit({ type: 'stopped' }); }, 5); },
  }));
  assert.match(await outcome(engine, /exactly one `stopped`/) ?? '', /after `stop\(\)` resolved/);
});

test('an invalid event fails the dictation check', async () => {
  const engine = brokenEngine((session, emit) => ({
    async stop() { emit({ type: 'error', code: 'kaput' as 'crashed', message: 'm', fatal: false }); await session.stop(); },
  }));
  assert.match(await outcome(engine, /exactly one `stopped`/) ?? '', /unknown error code `kaput`/);
});

test('a `final-only` engine that emits partials fails', async () => {
  const engine = createFakeDictationEngine({ interim: 'final-only' });
  const liar: DictationEngine = { ...createFakeDictationEngine({ interim: 'live' }), interim: 'final-only' };
  assert.equal(await outcome(engine, /exactly one `stopped`/), null);
  assert.match(await outcome(liar, /exactly one `stopped`/) ?? '', /`final-only` emitted `partial`/);
});

test('an engine that hallucinates on silence fails the silence check', async () => {
  const engine = createFakeDictationEngine({ transcribe: ({ samples }) => (samples ? 'Thank you.' : '') });
  assert.match(await outcome(engine, /silence gives no text/) ?? '', /draft/);
  const checks = dictationEngineChecks(engine, { silence: false }).map((c) => c.name);
  assert.ok(!checks.some((name) => /silence/.test(name)), '`silence: false` removes the check');
});

test('a `final` after cancel() or an abort fails', async () => {
  const flushOnCancel = brokenEngine((session, emit) => ({
    cancel() { emit({ type: 'final', text: 'flushed anyway' }); session.cancel(); },
  }));
  assert.match(await outcome(flushOnCancel, /cancel\(\) drops/) ?? '', /after the session was cancelled/);
  const flushOnAbort = brokenEngine((_session, emit, { signal }) => {
    signal.addEventListener('abort', () => emit({ type: 'final', text: 'flushed anyway' }), { once: true });
    return {};
  });
  // The fake's own abort listener ran first and closed the session: the late final follows `stopped`.
  assert.match(await outcome(flushOnAbort, /aborting the start signal/) ?? '', /`final` arrived after `stopped`/);
});

test('a cancel() or an abort that never emits `stopped` fails', async () => {
  const silentCancel = brokenEngine(() => ({ cancel() { /* drops the session without a word */ } }));
  assert.match(await outcome(silentCancel, /cancel\(\) drops/) ?? '', /no `stopped` event after cancel\(\)/);
  const deafToAbort = createFakeDictationEngine();
  const ignoresSignal: DictationEngine = {
    ...deafToAbort,
    start: (opts) => deafToAbort.start({ ...opts, signal: new AbortController().signal }),
  };
  assert.match(await outcome(ignoresSignal, /aborting the start signal/) ?? '', /no `stopped` event after the abort/);
});

test('a session that keeps text from the previous one fails the second-dictation check', async () => {
  let carried = '';
  const engine = createFakeDictationEngine({
    transcribe: ({ voicedMs }) => (voicedMs ? `${carried}hello` : ''),
  });
  const leaky: DictationEngine = {
    ...engine,
    async start(opts) {
      const session = await engine.start(opts);
      return { ...session, async stop() { await session.stop(); carried += 'hello '; } };
    },
  };
  assert.match(await outcome(leaky, /second dictation/, { transcript: 'hello' }) ?? '', /second dictation/);
});

test('session checks refuse to run on an engine that is not ready, and say why', async () => {
  const engine = createFakeDictationEngine({ availability: { state: 'needs-setup', reason: 'model not downloaded' } });
  assert.match(await outcome(engine, /exactly one `stopped`/) ?? '', /`needs-setup` \(model not downloaded\)/);
  assert.equal(await outcome(engine, /availability\(\) answers/), null);
});

test('a transcript expectation is checked', async () => {
  const engine = createFakeDictationEngine({ transcribe: ({ voicedMs }) => (voicedMs ? 'bonjour' : '') });
  assert.equal(await outcome(engine, /exactly one `stopped`/, { transcript: /bonjour/ }), null);
  assert.match(await outcome(engine, /exactly one `stopped`/, { transcript: 'au revoir' }) ?? '', /bonjour/);
});

test('readWavPcm refuses what it cannot read faithfully', () => {
  const wav = pcmToWav(speechLikePcm(0.1));
  const patched = (write: (view: DataView) => void): Uint8Array => {
    const copy = wav.slice();
    write(new DataView(copy.buffer));
    return copy;
  };
  assert.throws(() => readWavPcm(new TextEncoder().encode('not a wav at all')), /not a WAV/);
  assert.throws(() => readWavPcm(patched((v) => v.setUint16(22, 2, true))), /mono/);
  assert.throws(() => readWavPcm(patched((v) => v.setUint32(24, 44_100, true))), /16000 Hz, got 44100 Hz/);
  assert.throws(() => readWavPcm(patched((v) => v.setUint16(34, 24, true))), /unsupported WAV encoding/);
  assert.throws(() => readWavPcm(patched((v) => v.setUint32(40, 1_000_000, true))), /runs past the end/);
  assert.throws(() => readWavPcm(wav.subarray(0, 36)), /without a `data` chunk/);
});

// ── What passes ──────────────────────────────────────────────────────────────

test('readWavPcm reads 16-bit PCM and 32-bit float (the FLEURS trap) back to the same samples', () => {
  const pcm = speechLikePcm(0.2);
  const back = readWavPcm(pcmToWav(pcm));
  assert.equal(back.length, pcm.length);
  for (let i = 0; i < pcm.length; i += 1) assert.ok(Math.abs((back[i] ?? 0) - (pcm[i] ?? 0)) < 1 / 16_000);

  // The same file rewritten as IEEE float (format 3, 32 bits): read as 16-bit it would be noise.
  const float = new Uint8Array(44 + pcm.length * 4);
  float.set(pcmToWav(new Float32Array(0)).subarray(0, 44));
  const view = new DataView(float.buffer);
  view.setUint32(4, 36 + pcm.length * 4, true);
  view.setUint16(20, 3, true); view.setUint32(28, DICTATION_SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  view.setUint32(40, pcm.length * 4, true);
  pcm.forEach((s, i) => view.setFloat32(44 + i * 4, s, true));
  assert.deepEqual(readWavPcm(float), pcm);
});

test('fake PCM: lengths, silence, a voiced signal in range, deterministic, cut in ~100 ms copies', () => {
  assert.equal(silencePcm(1.5).length, 24_000);
  assert.ok(silencePcm(1).every((s) => s === 0));
  const speech = speechLikePcm(1);
  assert.equal(speech.length, 16_000);
  assert.ok(speech.every((s) => s >= -1 && s <= 1));
  assert.ok(Math.max(...speech.map(Math.abs)) > 0.1, 'the voiced signal is audible');
  assert.deepEqual(speechLikePcm(1), speech);
  const utterance = fakeUtterance({ lead: 0.3, speech: 1, tail: 0.5 });
  assert.equal(utterance.length, 28_800);
  assert.deepEqual(concatPcm(silencePcm(0.5), speech).subarray(8_000), speech);
  const chunks = chunkPcm(utterance);
  assert.equal(chunks.length, 18);
  assert.equal(chunks[0]?.length, 1_600);
  chunks[0]?.fill(1);
  assert.equal(utterance[0], 0, 'chunks are copies: an engine that mutates its input harms nothing');
  assert.throws(() => silencePcm(-1), RangeError);
});

test('the fake engine passes every check of the bench, in each interim mode', async () => {
  for (const interim of ['live', 'delayed', 'final-only'] as const) {
    const engine = createFakeDictationEngine({ interim });
    for (const check of dictationEngineChecks(engine, {
      transcript: 'fake transcript (1.5 s of speech)',
      manifest: { timon: { dictation: { engines: [{ id: 'fake-dictation' }] } } },
      run: { settleMs: 10 },
    })) {
      await check.run();
    }
  }
});

test('runDictation reports what the engine heard and how the session ended', async () => {
  const engine = createFakeDictationEngine({ interim: 'delayed' });
  const run = await runDictation(engine, fakeUtterance({ lead: 0.5, speech: 2.5, tail: 0.5 }), { language: 'fr', settleMs: 10 });
  assert.deepEqual(run.problems, []);
  assert.ok(run.partials.length >= 1, 'a delayed engine still shows provisional text');
  assert.deepEqual(run.finals, ['fake transcript (2.5 s of speech)']);
  assert.equal(run.text, 'fake transcript (2.5 s of speech)');
  assert.deepEqual(engine.sessions[0], { language: 'fr', samples: 56_000, feeds: 35, voicedMs: 2_500, ended: 'stop' });

  const cancelled = await runDictation(engine, fakeUtterance(), { end: 'cancel', endAfterMs: 500, settleMs: 10 });
  assert.deepEqual(cancelled.problems, []);
  assert.deepEqual(cancelled.finals, []);
  assert.equal(engine.sessions[1]?.ended, 'cancel');
  assert.equal(engine.sessions[1]?.samples, 8_000);
});

test('the fake engine can fail on start or mid-session, as a real one does', async () => {
  const refusing = createFakeDictationEngine({ fail: { on: 'start', message: 'no model' } });
  await assert.rejects(runDictation(refusing, fakeUtterance()), /no model/);

  const crashing = createFakeDictationEngine({ fail: { on: 'feed', afterMs: 500, code: 'crashed' } });
  const run = await runDictation(crashing, fakeUtterance(), { settleMs: 10 });
  assert.deepEqual(run.problems, []);
  assert.equal(run.errors[0]?.code, 'crashed');
  assert.equal(run.errors[0]?.fatal, true);
  assert.equal(run.stopped, true);
  assert.equal(crashing.sessions[0]?.ended, 'error');
  assert.equal(crashing.sessions[0]?.samples, 8_000, 'nothing is fed after the engine ended the session');
});

// ── The template, examples/plugin-dictation ─────────────────────────────────
// Its own test (`test/conformance.test.mjs`) is what an author runs, against
// the published kit (`packages/sdk/scripts/verify-consumer.mjs`); this is the
// same bench from the suite, so a change of the kit or of the contract that
// breaks the template is caught by `npm test`.

type HostMount = { api: (path: string, init?: RequestInit) => Promise<Response>; dispose: () => void };
type Template = { createPageEngine: () => DictationEngine; createDaemonEngine: (api: HostMount['api']) => DictationEngine };
const template = await import('../../../examples/plugin-dictation/lib/client.js') as unknown as Template;
const { mountHost } = await import('../../../examples/plugin-dictation/test/host.mjs') as unknown as {
  mountHost: (options?: { user?: () => { id: string } | null }) => HostMount;
};
const { readFileSync } = await import('node:fs');
const manifest = JSON.parse(readFileSync(new URL('../../../examples/plugin-dictation/package.json', import.meta.url), 'utf8')) as unknown;

test('template: the daemon routes refuse an anonymous caller and hide another account\'s dictation', async () => {
  const json = { 'content-type': 'application/json' };
  assert.equal((await mountHost({ user: () => null }).api('sessions', { method: 'POST', headers: json, body: '{}' })).status, 401);
  let caller = { id: 'alice' };
  const { api } = mountHost({ user: () => caller });
  const { id } = await (await api('sessions', { method: 'POST', headers: json, body: '{}' })).json() as { id: string };
  caller = { id: 'bob' };
  assert.equal((await api(`sessions/${id}/stop`, { method: 'POST' })).status, 404);
  const oversized = JSON.stringify({ pcm: Buffer.alloc(2 * 16_000 * 2 + 2).toString('base64') });
  caller = { id: 'alice' };
  assert.equal((await api(`sessions/${id}/audio`, { method: 'POST', headers: json, body: oversized })).status, 400);
});

test('template: both engines pass every check of the bench', async () => {
  const transcript = 'Example transcript: 1.5 s of speech (fr).';
  const host = mountHost();
  for (const engine of [template.createPageEngine(), template.createDaemonEngine(host.api)]) {
    for (const check of dictationEngineChecks(engine, { manifest, language: 'fr', transcript, run: { settleMs: 20 } })) {
      try { await check.run(); } catch (error) { throw new Error(`[${engine.id}] ${check.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  host.dispose();
});
