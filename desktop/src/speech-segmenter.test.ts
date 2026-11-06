import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interimPolicy, SpeechSegmenter, type InterimPolicy, type SegmentEvent } from './speech-segmenter.js';
import { concatAudio as join, hush, RATE, tone } from './speech-audio-fixtures.test.js';

/** Feeds `audio` in 100 ms chunks, like the renderer does. */
function feed(segmenter: SpeechSegmenter, audio: Float32Array): SegmentEvent[][] {
  const perPush: SegmentEvent[][] = [];
  for (let i = 0; i < audio.length; i += RATE / 10) perPush.push(segmenter.push(audio.subarray(i, i + RATE / 10)));
  return perPush;
}

test('silence never reaches the recognizer', () => {
  const s = new SpeechSegmenter({ sampleRate: RATE });
  assert.deepEqual(feed(s, hush(5000)).flat(), []);
  assert.equal(s.flush(), null);
});

test('an utterance followed by a pause becomes one final, with its onset', () => {
  const s = new SpeechSegmenter({ sampleRate: RATE });
  const events = feed(s, join(hush(500), tone(1000), hush(1200))).flat();
  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1);
  const final = finals[0]!;
  assert.ok(Math.abs(final.stats.voicedMs - 1000) <= 60, `voiced ${final.stats.voicedMs}`);
  // pre-roll (300 ms) + speech + the closing silence (800 ms)
  assert.ok(final.audio.length >= RATE * 2 && final.audio.length <= RATE * 2.2, `length ${final.audio.length}`);
  assert.equal(s.flush(), null);
});

test('a click is noise, not an utterance', () => {
  const s = new SpeechSegmenter({ sampleRate: RATE });
  assert.deepEqual(feed(s, join(hush(300), tone(60, 0.5), hush(1500))).flat(), []);
});

test('partials come at most once per push, spaced in audio time', () => {
  const s = new SpeechSegmenter({ sampleRate: RATE, partialEveryMs: 1000 });
  const perPush = feed(s, tone(4000));
  assert.ok(perPush.every((events) => events.filter((e) => e.type === 'partial').length <= 1));
  const partials = perPush.flat().filter((e) => e.type === 'partial');
  assert.ok(partials.length >= 2 && partials.length <= 4, `${partials.length} partials`);
  for (let i = 1; i < partials.length; i += 1) assert.ok(partials[i]!.audio.length - partials[i - 1]!.audio.length >= RATE * 0.99);
  const rest = s.flush();
  assert.ok(rest && rest.audio.length >= RATE * 4);
});

test('a long monologue is cut into bounded utterances', () => {
  const s = new SpeechSegmenter({ sampleRate: RATE, maxUtteranceMs: 5000 });
  const finals = feed(s, tone(12_000)).flat().filter((e) => e.type === 'final');
  assert.equal(finals.length, 2);
  for (const final of finals) assert.ok(final.audio.length <= RATE * 5.4);
  assert.ok((s.flush()?.audio.length ?? 0) > RATE);
});

test('a steady hum stops counting as speech once the floor has adapted', () => {
  const s = new SpeechSegmenter({ sampleRate: RATE });
  const hum = tone(10_000, 0.03);
  const during = feed(s, hum).flat().filter((e) => e.type === 'final');
  assert.ok(during.length <= 1, `${during.length} finals from the hum`);
  const speech = feed(s, join(tone(1500, 0.4), tone(1500, 0.03))).flat().filter((e) => e.type === 'final');
  assert.equal(speech.length, 1);
  assert.ok(Math.abs(speech[0]!.stats.voicedMs - 1500) <= 90, `voiced ${speech[0]!.stats.voicedMs}`);
});

test('reset forgets the utterance in progress', () => {
  const s = new SpeechSegmenter({ sampleRate: RATE });
  feed(s, tone(800));
  s.reset();
  assert.equal(s.flush(), null);
});

function partialsOf(interim: InterimPolicy | undefined, audio: Float32Array): SegmentEvent[] {
  return feed(new SpeechSegmenter({ sampleRate: RATE, interim }), audio).flat().filter((e) => e.type === 'partial');
}

test('final-only never decodes a partial, and still commits the utterance', () => {
  const s = new SpeechSegmenter({ sampleRate: RATE, interim: { mode: 'final-only', minUtteranceMs: 0 } });
  const events = feed(s, join(tone(6000), hush(1200))).flat();
  assert.equal(events.filter((e) => e.type === 'partial').length, 0);
  assert.equal(events.filter((e) => e.type === 'final').length, 1);
});

test('no partial is decoded before the minimum utterance length', () => {
  // A 1.5 s utterance (with its pre-roll) never shows text before its final under a 2 s floor.
  assert.equal(partialsOf({ mode: 'live', minUtteranceMs: 2000 }, join(hush(500), tone(1500), hush(1200))).length, 0);
  const partials = partialsOf({ mode: 'live', minUtteranceMs: 2000 }, tone(5000));
  assert.ok(partials.length >= 1, `${partials.length} partials`);
  assert.ok(partials[0]!.audio.length >= RATE * 2, `first partial ${partials[0]!.audio.length}`);
});

test('delayed partials wait 3 s and come no more than every 3 s', () => {
  assert.equal(partialsOf({ mode: 'delayed', minUtteranceMs: 3000 }, tone(2800)).length, 0);
  const partials = partialsOf({ mode: 'delayed', minUtteranceMs: 3000 }, tone(10_000));
  assert.ok(partials.length >= 2 && partials.length <= 3, `${partials.length} partials`);
  assert.ok(partials[0]!.audio.length >= RATE * 3);
  for (let i = 1; i < partials.length; i += 1) assert.ok(partials[i]!.audio.length - partials[i - 1]!.audio.length >= RATE * 2.99);
});

test('live partials start after a second, as before', () => {
  const partials = partialsOf(undefined, tone(2500));
  assert.ok(partials.length >= 1);
  assert.ok(partials[0]!.audio.length < RATE * 1.5, `first partial ${partials[0]!.audio.length}`);
});

test('a new interim policy applies to the next utterance', () => {
  const s = new SpeechSegmenter({ sampleRate: RATE });
  s.setInterim({ mode: 'final-only', minUtteranceMs: 0 });
  assert.equal(feed(s, tone(4000)).flat().filter((e) => e.type === 'partial').length, 0);
});

test('the user can make provisional text stricter, never looser', () => {
  assert.deepEqual(interimPolicy({ mode: 'final-only' }, { user: 'live', languageDetected: false }), { mode: 'final-only', minUtteranceMs: 0 });
  assert.deepEqual(interimPolicy({ mode: 'delayed' }, { user: 'live', languageDetected: false }), { mode: 'delayed', minUtteranceMs: 3000 });
  assert.deepEqual(interimPolicy({ mode: 'live', minUtteranceMs: 1500 }, { user: 'final-only', languageDetected: false }), { mode: 'final-only', minUtteranceMs: 1500 });
  assert.deepEqual(interimPolicy({ mode: 'live' }, { user: 'delayed', languageDetected: false }), { mode: 'delayed', minUtteranceMs: 3000 });
  assert.deepEqual(interimPolicy({ mode: 'live', minUtteranceMs: 1500 }, { user: 'auto', languageDetected: false }), { mode: 'live', minUtteranceMs: 1500 });
  assert.deepEqual(interimPolicy({ mode: 'delayed', minUtteranceMs: 4000 }, { languageDetected: false }), { mode: 'delayed', minUtteranceMs: 4000 });
});

test('a model that detects the language never shows a partial under 2 s, whatever its entry says', () => {
  assert.deepEqual(interimPolicy({ mode: 'live' }, { languageDetected: true }), { mode: 'live', minUtteranceMs: 2000 });
  assert.deepEqual(interimPolicy({ mode: 'live', minUtteranceMs: 500 }, { user: 'live', languageDetected: true }), { mode: 'live', minUtteranceMs: 2000 });
  assert.deepEqual(interimPolicy({ mode: 'delayed' }, { languageDetected: true }), { mode: 'delayed', minUtteranceMs: 3000 });
  assert.equal(partialsOf(interimPolicy({ mode: 'live' }, { languageDetected: true }), join(hush(400), tone(1400), hush(1000))).length, 0);
});
