/**
 * The mascots' live states outside the chat (docs/AGENT-MASCOT.md): what an
 * event says, and one store for the whole page — N avatars never mean N
 * subscriptions, let alone N requests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActiveAgent } from '@/lib/agent-state';
import {
  createAgentLiveStore, liveMascotState, taskOfFrame, toolOfFrame, useAgentLiveState,
  type AgentLiveStore, type LiveStoreDeps,
} from './agent-live-state';
import { REACTION_MS } from './agent-activity';

Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const row = (name: string, state: ActiveAgent['state'], extra: Partial<ActiveAgent> = {}): ActiveAgent => ({
  name, state, mission_id: `m-${name}`, at: 1, pending_count: 0, project: null, ...extra,
});

const frame = (missionId: string, payload: unknown) => JSON.stringify({ kind: 'event', missionId, type: 'x', timestamp: 1, payload });
const assistant = (...content: unknown[]) => ({ type: 'assistant', message: { content } });

test('a row of the active list → its state', () => {
  assert.equal(liveMascotState(undefined, undefined), 'sleeping', 'no live mission');
  assert.equal(liveMascotState(row('a', 'needs_action'), 'Edit'), 'waiting', 'a card waits: whatever the tool');
  assert.equal(liveMascotState(row('a', 'thinking'), undefined), 'thinking');
  assert.equal(liveMascotState(row('a', 'thinking'), null), 'thinking', 'it writes');
  assert.equal(liveMascotState(row('a', 'thinking'), 'Edit'), 'working');
  assert.equal(liveMascotState(row('a', 'thinking'), 'Grep'), 'searching');
  assert.equal(liveMascotState(row('a', 'thinking'), 'mcp__rooks__kanban_list'), 'searching');
  assert.equal(liveMascotState(row('a', 'idle'), null), 'idle', 'conversation open, no turn');
  assert.equal(liveMascotState(row('a', 'idle', { liveness: 'ended' }), null), 'sleeping');
  assert.equal(liveMascotState(row('a', 'idle', { liveness: 'interrupted' }), null), 'sleeping');
  assert.equal(liveMascotState(row('a', 'done'), null), 'sleeping', 'its mission ended');
});

test('an event frame → the tool its mission runs', () => {
  assert.deepEqual(toolOfFrame(frame('m1', assistant({ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Edit' }))), { missionId: 'm1', tool: 'Edit' }, 'the last call');
  assert.deepEqual(toolOfFrame(frame('m1', assistant({ type: 'text', text: 'hi' }))), { missionId: 'm1', tool: null }, 'it writes');
  assert.deepEqual(toolOfFrame(frame('m1', { type: 'result' })), { missionId: 'm1', tool: null }, 'its turn ended');
  assert.equal(toolOfFrame(frame('m1', assistant({ type: 'thinking' }))), null, 'reasoning says nothing');
  assert.equal(toolOfFrame(frame('m1', { type: 'user' })), null);
  assert.equal(toolOfFrame('not json'), null);
  assert.equal(toolOfFrame(JSON.stringify({ payload: { type: 'result' } })), null, 'no mission');
  assert.equal(taskOfFrame(JSON.stringify({ kind: 'task_done', taskId: 'c483a9dd-24cd' })), 'c483a9dd-24cd');
  assert.equal(taskOfFrame(JSON.stringify({ taskId: '../x' })), null, 'never an id that would leave its route segment');
  assert.equal(taskOfFrame('{'), null);
});

type Harness = {
  store: AgentLiveStore;
  setRows(rows: ActiveAgent[]): void;
  send(type: string, data: string): void;
  flushTimers(): void;
  counts: { stream: Record<string, number>; active: number; streamOff: number; activeOff: number; taskReads: number };
};

function harness(taskAgents: Record<string, string> = {}): Harness {
  let rows: ActiveAgent[] = [];
  const stream = new Map<string, Set<(data: string) => void>>();
  const active = new Set<() => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const counts = { stream: {} as Record<string, number>, active: 0, streamOff: 0, activeOff: 0, taskReads: 0 };
  const deps: LiveStoreDeps = {
    onStream(type, fn) {
      counts.stream[type] = (counts.stream[type] ?? 0) + 1;
      const set = stream.get(type) ?? new Set();
      set.add(fn);
      stream.set(type, set);
      return () => { counts.streamOff += 1; set.delete(fn); };
    },
    subscribeActive(fn) {
      counts.active += 1;
      active.add(fn);
      return () => { counts.activeOff += 1; active.delete(fn); };
    },
    readActive: () => rows,
    taskAgent: async (id) => { counts.taskReads += 1; return taskAgents[id] ?? null; },
    setTimer: (fn) => { const id = nextTimer++; timers.set(id, fn); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (h) => { timers.delete(h as unknown as number); },
  };
  return {
    store: createAgentLiveStore(deps),
    setRows(next) { rows = next; for (const fn of active) fn(); },
    send(type, data) { for (const fn of stream.get(type) ?? []) fn(data); },
    flushTimers() { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn(); },
    counts,
  };
}

test('thirty avatars share one subscription to each source, released with the last', () => {
  const h = harness();
  const offs = Array.from({ length: 30 }, () => h.store.subscribe(() => {}));
  assert.deepEqual(h.counts.stream, { event: 1, task_done: 1 }, 'one listener per stream event, whatever the avatars');
  assert.equal(h.counts.active, 1, 'one reader of the active list (itself one poll)');
  for (const off of offs.slice(1)) off();
  assert.equal(h.counts.streamOff + h.counts.activeOff, 0, 'still one avatar: still listening');
  offs[0]!();
  assert.equal(h.counts.streamOff, 2);
  assert.equal(h.counts.activeOff, 1);
  offs[0]!();
  assert.equal(h.counts.activeOff, 1, 'a second unsubscribe is a no-op');
  h.store.subscribe(() => {});
  assert.equal(h.counts.active, 2, 'a new avatar starts it again');
});

test('the active list, then the tool of its mission, drive the state; strangers are ignored', () => {
  const h = harness();
  let notified = 0;
  h.store.subscribe(() => { notified += 1; });
  assert.equal(h.store.stateOf('rooks'), 'sleeping');
  h.setRows([row('rooks', 'thinking')]);
  assert.equal(h.store.stateOf('rooks'), 'thinking');
  h.send('event', frame('m-rooks', assistant({ type: 'tool_use', name: 'Grep' })));
  assert.equal(h.store.stateOf('rooks'), 'searching');
  h.send('event', frame('m-rooks', assistant({ type: 'tool_use', name: 'Write' })));
  assert.equal(h.store.stateOf('rooks'), 'working');
  const before = notified;
  h.send('event', frame('m-other', assistant({ type: 'tool_use', name: 'Grep' })));
  h.send('event', frame('m-rooks', assistant({ type: 'tool_use', name: 'Write' })));
  assert.equal(notified, before, 'a mission off the list, or the same tool again, notifies nobody');
  h.setRows([row('rooks', 'needs_action')]);
  assert.equal(h.store.stateOf('rooks'), 'waiting');
  h.setRows([]);
  assert.equal(h.store.stateOf('rooks'), 'sleeping');
});

test('a turn that ends makes the agent happy, a task done makes it celebrate, briefly', async () => {
  const h = harness({ t1: 'rooks' });
  h.store.subscribe(() => {});
  h.setRows([row('rooks', 'thinking')]);
  h.setRows([row('rooks', 'idle')]);
  assert.equal(h.store.stateOf('rooks'), 'happy');
  h.flushTimers();
  assert.equal(h.store.stateOf('rooks'), 'idle', `back to its activity after ${REACTION_MS} ms`);

  h.send('task_done', JSON.stringify({ kind: 'task_done', taskId: 't1' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counts.taskReads, 1, 'one read per closed task, not per avatar');
  assert.equal(h.store.stateOf('rooks'), 'celebrate');
  h.flushTimers();
  assert.equal(h.store.stateOf('rooks'), 'idle');
  h.send('task_done', JSON.stringify({ kind: 'task_done', taskId: 'unknown' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.store.stateOf('rooks'), 'idle', 'a task of nobody known changes nothing');
});

test('useAgentLiveState: the store\'s state for a name, nothing (and no subscription) for null', () => {
  const h = harness();
  h.store.subscribe(() => {});
  h.setRows([row('rooks', 'needs_action')]);
  let seen: Array<string | null> = [];
  const Probe = ({ name }: { name: string | null }) => {
    seen = [...seen, useAgentLiveState(name, h.store)];
    return null;
  };
  // A server render reads the server snapshot: a mascot rests until the client knows.
  renderToStaticMarkup(React.createElement(Probe, { name: 'rooks' }));
  renderToStaticMarkup(React.createElement(Probe, { name: null }));
  assert.deepEqual(seen, ['sleeping', null]);
});
