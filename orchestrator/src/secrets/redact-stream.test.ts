/**
 * Chunk-boundary safety of the live delta stream (SECRETS-VAULT.md §7.1).
 *
 * The pure filter (`redact.test.ts`) proves a value is masked when it is whole
 * inside the text it is handed. That is exactly what a streamed answer does not
 * guarantee: the CLI cuts its fragments wherever it flushed, so the interesting
 * failure is a token split across two of them. Hence one level of unit cases on
 * the hold-back of the *ambiguous suffix only*, and cases at SSE level — the
 * wire is where the leak would actually be visible, and asserting on the
 * CONCATENATION of everything written is the only assertion the split cannot
 * escape.
 */
// Isolates TIMON_HOME BEFORE any module touching Timon state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { REDACTION_PLACEHOLDER, setRedactionSource } from './redact.js';
import {
  dropRedactStream,
  flushRedactStream,
  heldStreamCount,
  redactStreamChunk,
} from './redact-stream.js';
import { bus } from '../bus.js';
import { sseHandler } from '../sse.js';

const SECRET = 'sk-live-abcdefghijklmnop';
const PREFIX = 'sk-live-abc';

/** Swaps in a fixed value list and puts back whatever `db.ts` registered. */
function withValues(values: string[], body: () => void): void {
  const previous = setRedactionSource(() => values);
  try {
    body();
  } finally {
    setRedactionSource(previous);
  }
}

/** Feeds fragments to one mission and returns everything the buffer let out,
 *  flush included — i.e. exactly what a consumer would have seen at end of
 *  turn. */
function stream(missionId: string, chunks: string[]): string {
  let out = '';
  for (const c of chunks) out += redactStreamChunk(missionId, c, 'append');
  out += flushRedactStream(missionId);
  return out;
}

test('a value split across two fragments never reaches the consumer', () => {
  withValues([SECRET], () => {
    const out = stream('m-split', ['token: sk-live-abc', 'defghijklmnop, use it']);
    assert.ok(!out.includes(SECRET), `the value survived: ${out}`);
    assert.equal(out, 'token: ***, use it');
  });
});

test('a value split character by character never reaches the consumer', () => {
  withValues([SECRET], () => {
    const out = stream('m-charwise', [...`here is ${SECRET} ok`]);
    assert.ok(!out.includes(SECRET), `the value survived: ${out}`);
    assert.equal(out, 'here is *** ok');
  });
});

test('nothing is lost: text with no secret comes out whole, in order', () => {
  withValues([SECRET], () => {
    const out = stream('m-plain', ['Bonjour ', 'le ', 'monde, voici un texte assez long.']);
    assert.equal(out, 'Bonjour le monde, voici un texte assez long.');
  });
});

test('an empty vault buffers nothing at all (latency unchanged)', () => {
  withValues([], () => {
    assert.equal(redactStreamChunk('m-empty', 'hello', 'append'), 'hello');
    assert.equal(heldStreamCount(), 0);
  });
});

test('a non-empty vault emits ordinary chunks immediately and holds nothing', () => {
  withValues([SECRET], () => {
    for (const chunk of ['Bonjour ', 'le ', 'monde.']) {
      assert.equal(redactStreamChunk('m-imm', chunk, 'append'), chunk);
      assert.equal(heldStreamCount(), 0, `held after ${JSON.stringify(chunk)}`);
    }
  });
});

test('a vault emptied mid-stream masks the held prefix instead of leaking it', () => {
  const missionId = 'm-emptied';
  withValues([SECRET], () => {
    const out = redactStreamChunk(missionId, `token: ${PREFIX}`, 'append');
    assert.equal(out, 'token: ');
    assert.equal(heldStreamCount(), 1, 'nothing was held, the case proves nothing');
  });
  withValues([], () => {
    const out = redactStreamChunk(missionId, ' and more', 'append');
    assert.equal(out, `${REDACTION_PLACEHOLDER} and more`);
    assert.ok(!out.includes(PREFIX), `the prefix leaked: ${out}`);
    assert.equal(heldStreamCount(), 0);
  });
});

test('the held suffix is only the ambiguous prefix, flushed as the placeholder', () => {
  withValues([SECRET], () => {
    const missionId = 'm-suffix';
    const out = redactStreamChunk(missionId, `hello ${PREFIX}`, 'append');
    assert.equal(out, 'hello ');
    assert.equal(heldStreamCount(), 1, 'one mission, one entry');
    assert.equal(flushRedactStream(missionId), REDACTION_PLACEHOLDER);
    assert.equal(heldStreamCount(), 0, 'the entry outlived its stream');
    assert.equal(flushRedactStream(missionId), '', 'flushing twice must not duplicate text');
  });
});

test('two missions do not stitch their fragments together', () => {
  withValues([SECRET], () => {
    const a1 = redactStreamChunk('m-a', 'token: sk-live-abc', 'append');
    const b1 = redactStreamChunk('m-b', 'unrelated prose here', 'append');
    const a = a1 + redactStreamChunk('m-a', 'defghijklmnop.', 'append') + flushRedactStream('m-a');
    const b = b1 + redactStreamChunk('m-b', ' and its end.', 'append') + flushRedactStream('m-b');
    assert.equal(a, 'token: ***.');
    assert.ok(!b.includes('***'), b);
    assert.equal(b, 'unrelated prose here and its end.');
  });
});

test('a replace snapshot drops the tail instead of duplicating it', () => {
  withValues([SECRET], () => {
    const missionId = 'm-replace';
    redactStreamChunk(missionId, 'partial answ', 'append');
    const out = redactStreamChunk(missionId, `full answer with ${SECRET} inside`, 'replace');
    assert.equal(out, 'full answer with *** inside');
    assert.equal(heldStreamCount(), 0);
  });
});

test('a turn ending on a strict prefix never emits any sensitive portion', () => {
  withValues([SECRET], () => {
    const missionId = 'm-end-prefix';
    const emitted = redactStreamChunk(missionId, `token: ${PREFIX}`, 'append');
    assert.ok(!emitted.includes(PREFIX), `prefix went out live: ${emitted}`);
    assert.ok(!SECRET.startsWith(emitted.trim()) || emitted.trim() === '', emitted);
    const flushed = flushRedactStream(missionId);
    assert.equal(flushed, REDACTION_PLACEHOLDER);
    const seen = emitted + flushed;
    assert.ok(!seen.includes(PREFIX), `prefix survived the flush: ${seen}`);
    assert.ok(!seen.includes(SECRET.slice(0, 7)), `a shorter prefix leaked: ${seen}`);
  });
});

test('dropRedactStream clears the entry without emitting it', () => {
  withValues([SECRET], () => {
    const missionId = 'm-drop';
    const emitted = redactStreamChunk(missionId, `token: ${PREFIX}`, 'append');
    assert.equal(heldStreamCount(), 1);
    dropRedactStream(missionId);
    assert.equal(heldStreamCount(), 0);
    assert.equal(flushRedactStream(missionId), '', 'drop must not leave anything to flush');
    assert.equal(emitted, 'token: ');
  });
});

// ── SSE level: what actually goes out on the wire ──────────────────────────

/** Fake req/res pair: we keep only what was written to the stream. */
function fakeStream(missionId: string): { chunks: string[]; close: () => void } {
  const chunks: string[] = [];
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  Object.assign(res, {
    set: () => res,
    flushHeaders: () => {},
    write: (s: string) => { chunks.push(s); return true; },
  });
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, { params: { id: missionId } });
  sseHandler(req, res);
  return { chunks, close: () => { (req as unknown as EventEmitter).emit('close'); } };
}

test('a secret published in two successive deltas never appears on the SSE wire', () => {
  const missionId = 'mission-redact-sse-01';
  const s = fakeStream(missionId);
  withValues([SECRET], () => {
    for (const text of ['Here is the token: sk-live-abc', 'defghijklmnop — keep it safe.']) {
      bus.publish({ kind: 'event_delta', missionId, type: 'assistant_delta', payload: { text, mode: 'append' } });
    }
    // End of turn releases the hold-back buffer: the tail must come out masked,
    // not in the clear and not swallowed.
    bus.publish({ kind: 'turn_complete', missionId });
  });
  const wire = s.chunks.join('');
  assert.ok(!wire.includes(SECRET), `the value went out on the wire: ${wire}`);
  assert.ok(wire.includes('***'), `nothing was masked at all: ${wire}`);
  assert.ok(wire.includes('keep it safe.'), `the tail was swallowed: ${wire}`);
  s.close();
});

test('a complete event releases the held tail before the full message lands', () => {
  const missionId = 'mission-redact-sse-02';
  const s = fakeStream(missionId);
  withValues([SECRET], () => {
    bus.publish({ kind: 'event_delta', missionId, type: 'assistant_delta', payload: { text: `done ${SECRET} bye`, mode: 'append' } });
    bus.publish({
      kind: 'event', missionId, type: 'assistant', timestamp: Date.now(),
      payload: { text: `done ${SECRET} bye` },
    });
  });
  const wire = s.chunks.join('');
  assert.ok(!wire.includes(SECRET), `the value went out on the wire: ${wire}`);
  // The released tail must be written BEFORE the complete message, otherwise
  // the UI would print the end of the answer after the answer itself.
  assert.ok(wire.lastIndexOf('event: event_delta') < wire.indexOf('event: event\n'), wire);
  assert.ok(wire.includes('bye'), `the tail was swallowed: ${wire}`);
  s.close();
});

test('a turn ending on a strict prefix never puts a sensitive portion on the SSE wire', () => {
  const missionId = 'mission-redact-sse-03';
  const s = fakeStream(missionId);
  withValues([SECRET], () => {
    bus.publish({
      kind: 'event_delta', missionId, type: 'assistant_delta',
      payload: { text: `token: ${PREFIX}`, mode: 'append' },
    });
    bus.publish({ kind: 'turn_complete', missionId });
  });
  const wire = s.chunks.join('');
  assert.ok(!wire.includes(PREFIX), `the prefix went out on the wire: ${wire}`);
  assert.ok(!wire.includes('sk-live'), `a shorter prefix leaked: ${wire}`);
  assert.ok(wire.includes('***'), `the remaining report was not masked: ${wire}`);
  s.close();
});

test('mission_complete drops the held suffix without flushing it', () => {
  const missionId = 'mission-redact-sse-04';
  const s = fakeStream(missionId);
  withValues([SECRET], () => {
    bus.publish({
      kind: 'event_delta', missionId, type: 'assistant_delta',
      payload: { text: `token: ${PREFIX}`, mode: 'append' },
    });
    assert.equal(heldStreamCount(), 1, 'nothing was held, the case proves nothing');
    bus.publish({ kind: 'mission_complete', missionId, status: 'terminated', exitCode: 0 });
    assert.equal(heldStreamCount(), 0);
  });
  const wire = s.chunks.join('');
  assert.ok(!wire.includes(PREFIX), `the prefix went out on the wire: ${wire}`);
  assert.ok(!wire.includes('sk-live'), `a shorter prefix leaked: ${wire}`);
  // Cleanup without flush: the placeholder is NOT emitted in place of the
  // dropped suffix. The live stream stopped at "token: ".
  assert.ok(!wire.includes('***'), `the dropped suffix was flushed as a mask: ${wire}`);
  s.close();
});
