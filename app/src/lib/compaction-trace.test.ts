/**
 * A native compaction's rows fold into one trace line, never into bubbles
 * of the human's (TODO #504, docs/MISSION-COMPACT.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundaryTracePatch,
  foldTrace,
  isCliSynthetic,
  isOpenTrace,
  readCompactBoundary,
  readCompactOutcome,
  readCompactionUser,
  userTracePatch,
  type CompactionTraceView,
} from './compaction-trace';

const COMMAND = { type: 'user', message: { role: 'user', content: '/compact' }, origin: { kind: 'system', from: 'orchestrator' } };
const SUMMARY = {
  type: 'user',
  isSynthetic: true,
  message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation…' }] },
};
const ACK = { type: 'user', isReplay: true, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } };
const BOUNDARY = { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 132_000, post_tokens: 18_000 } };
const OUTCOME = { type: 'compact', operation_id: 'op', mode: 'native', outcome: 'done', backend: 'claude', model: 'opus', target_mission_id: 'm1', error: null, duration_ms: 9000 };

test('the CLI rows and the command are read as compaction, not as the human', () => {
  assert.deepEqual(readCompactionUser(COMMAND), { kind: 'command' });
  assert.deepEqual(readCompactionUser(SUMMARY), { kind: 'summary', text: 'This session is being continued from a previous conversation…' });
  assert.deepEqual(readCompactionUser(ACK), { kind: 'ack' });
});

test('an ordinary message stays a message', () => {
  assert.equal(readCompactionUser({ type: 'user', message: { content: '/compact' } }), null, 'typed by the human');
  assert.equal(readCompactionUser({ type: 'user', origin: { kind: 'system', from: 'orchestrator' }, message: { content: 'Task done: review it.' } }), null, 'a daemon prompt in prose');
  assert.equal(readCompactionUser({ type: 'user', isReplay: true, message: { content: 'hello' } }), null, 'a replayed human message');
});

const IMAGE_NOTE = {
  type: 'user',
  isSynthetic: true,
  message: { role: 'user', content: [{ type: 'text', text: '[Image: original 1920x2160, displayed at 1778x2000. Multiply coordinates by 1.08 to map to original image.]' }] },
};
const SKILL_BODY = {
  type: 'user',
  isSynthetic: true,
  message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /home/u/.claude/skills/audit\n\n# audit' }] },
};

test('a synthetic row that is not the summary is no compaction (an image note, a skill body)', () => {
  assert.equal(readCompactionUser(IMAGE_NOTE), null, 'image note');
  assert.equal(readCompactionUser(SKILL_BODY), null, 'skill body');
  assert.ok(isCliSynthetic(IMAGE_NOTE) && isCliSynthetic(SKILL_BODY), 'still plumbing, never a bubble');
  assert.equal(isCliSynthetic(COMMAND), false);
  assert.equal(isCliSynthetic({ type: 'user', message: { content: 'hi' } }), false);
});

test('the summary is told by its opening words, as a string or as blocks', () => {
  const asString = { type: 'user', isSynthetic: true, isReplay: false, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } };
  assert.equal(readCompactionUser(asString)?.kind, 'summary');
  assert.equal(readCompactionUser(SUMMARY)?.kind, 'summary');
});

test('a reworded summary is taken only by a trace still waiting for one', () => {
  const reworded = { type: 'user', isSynthetic: true, message: { content: 'Summary of the earlier conversation…' } };
  assert.equal(readCompactionUser(reworded), null, 'no trace open');
  const open = foldTrace(null, boundaryTracePatch(readCompactBoundary(BOUNDARY)!));
  assert.deepEqual(readCompactionUser(reworded, open), { kind: 'summary', text: 'Summary of the earlier conversation…' });
  const summarised = foldTrace(open, userTracePatch(readCompactionUser(SUMMARY)!));
  assert.equal(readCompactionUser(IMAGE_NOTE, summarised), null, 'the summary already came');
  const closed = foldTrace(open, readCompactOutcome(OUTCOME)!);
  assert.equal(readCompactionUser(SKILL_BODY, closed), null, 'the daemon closed the trace');
});

test('a /compact typed by hand still ends in a trace with its summary', () => {
  // The human's own `/compact` has no origin: it stays their bubble, the CLI's rows fold.
  assert.equal(readCompactionUser({ type: 'user', message: { content: '/compact' } }), null);
  let trace: CompactionTraceView | null = foldTrace(null, boundaryTracePatch(readCompactBoundary(BOUNDARY)!));
  trace = foldTrace(trace, userTracePatch(readCompactionUser(SUMMARY, trace)!));
  trace = foldTrace(trace, userTracePatch(readCompactionUser(ACK, trace)!));
  assert.equal(trace.outcome, 'done');
  assert.match(trace.summary ?? '', /continued from a previous conversation/);
  assert.equal(readCompactionUser(IMAGE_NOTE, trace), null, 'a later image note stays out of the trace');
});

test('a whole native compaction folds into one closed trace with its summary and tokens', () => {
  let trace: CompactionTraceView | null = null;
  for (const row of [COMMAND, BOUNDARY, SUMMARY, ACK]) {
    assert.ok(trace === null || isOpenTrace(trace), 'the trace stays open until the outcome');
    const user = readCompactionUser(row);
    const boundary = readCompactBoundary(row);
    trace = foldTrace(trace, user ? userTracePatch(user) : boundaryTracePatch(boundary!));
  }
  trace = foldTrace(trace, readCompactOutcome(OUTCOME)!);
  assert.equal(isOpenTrace(trace), false);
  assert.equal(trace.outcome, 'done');
  assert.equal(trace.mode, 'native');
  assert.equal(trace.preTokens, 132_000);
  assert.equal(trace.postTokens, 18_000);
  assert.match(trace.summary ?? '', /continued from a previous conversation/);
  assert.equal(trace.targetMissionId, null, 'native: no other conversation to open');
});

test('a fork outcome names the new conversation, a failure its reason', () => {
  const fork = foldTrace(null, readCompactOutcome({ ...OUTCOME, mode: 'fork', target_mission_id: 'm2' })!);
  assert.equal(fork.targetMissionId, 'm2');
  const failed = foldTrace(null, readCompactOutcome({ ...OUTCOME, outcome: 'error', error: 'summary: timeout' })!);
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.error, 'summary: timeout');
  assert.equal(readCompactOutcome({ type: 'compact' }), null);
});

test('the trace renders as a quiet line with its summary folded', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'MouseEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { CompactionTrace } = await import('../components/chat/compaction-trace');
  let trace: CompactionTraceView | null = null;
  for (const row of [COMMAND, BOUNDARY, SUMMARY, ACK]) {
    const user = readCompactionUser(row);
    trace = foldTrace(trace, user ? userTracePatch(user) : boundaryTracePatch(readCompactBoundary(row)!));
  }
  const root = createRoot(document.getElementById('root')!);
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  await React.act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: router as never },
      React.createElement(CompactionTrace, { trace: trace!, agentName: 'coder', time: '10:42' })));
  });
  const host = document.getElementById('root')!;
  assert.ok(host.querySelector('[data-compaction-trace]'), 'a trace, not a bubble');
  assert.match(host.textContent ?? '', /Conversation compacted · 132k → 18k tokens/);
  assert.doesNotMatch(host.textContent ?? '', /continued from a previous conversation/, 'the summary starts folded');
  const toggle = Array.from(host.querySelectorAll('button')).find((b) => /Show the summary/.test(b.textContent ?? ''));
  assert.ok(toggle, 'the summary can be unfolded');
  await React.act(async () => { toggle.click(); });
  assert.match(host.textContent ?? '', /continued from a previous conversation/);
  await React.act(async () => { root.unmount(); });
});
