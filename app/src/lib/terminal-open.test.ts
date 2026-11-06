import assert from 'node:assert/strict';
import test from 'node:test';
import { openScope, openTerminalSession, pickSession, TERMINAL_ISLAND_CONTENT, type OpenView, type TerminalOpenDeps } from './terminal-open';
import type { TerminalSession, TerminalStatus } from './terminal-web';

const shell = (id: string, scope: string | null, exited = false): TerminalSession => ({
  id, scope, cwd: '/w', shell: 'bash', createdAt: 0, lastActivityAt: 0, clients: 0, cols: 80, rows: 24, exited, exitCode: null,
});

function deps(status: TerminalStatus, log: string[] = [], shown = true): TerminalOpenDeps {
  let n = 0;
  return {
    status: async () => status,
    create: async (input) => { n += 1; log.push(`create:${input.cwd ?? '-'}:${input.scope ? 'scoped' : 'none'}`); return shell(`new${n}`, input.scope ? 'project:timon' : null); },
    show: (content) => { log.push(`show:${content.params.sessionId}:${content.params.scope}`); return shown; },
    insert: (id, text) => { log.push(`insert:${id}:${text}`); },
  };
}

const ok = (sessions: TerminalSession[]): TerminalStatus => ({ enabled: true, sessions });
const scope = { kind: 'project', slug: 'timon' } as const;

test('an open with nothing named shows the scope\'s latest live shell, never another scope\'s', () => {
  const sessions = [shell('a', 'project:timon'), shell('b', 'project:globex'), shell('c', 'project:timon'), shell('d', 'project:timon', true)];
  const pick = pickSession(sessions, 'project:timon', {});
  assert.equal(pick.kind === 'use' && pick.session.id, 'c');
});

test('a session of another scope is not shown; the scope\'s own shell stands in', () => {
  const sessions = [shell('a', 'project:timon'), shell('b', 'project:globex')];
  const pick = pickSession(sessions, 'project:timon', { sessionId: 'b' });
  assert.equal(pick.kind === 'use' && pick.session.id, 'a');
});

test('a folder asks for a new shell even when one exists', () => {
  assert.deepEqual(pickSession([shell('a', 'project:timon')], 'project:timon', { cwd: '/repo' }), { kind: 'create', cwd: '/repo' });
});

test('no shell yet: one is started, then shown as an island content of the scope', async () => {
  const log: string[] = [];
  const out = await openTerminalSession(scope, {}, deps(ok([]), log));
  assert.deepEqual(out, { kind: 'opened', sessionId: 'new1' });
  assert.deepEqual(log, ['create:-:scoped', 'show:new1:project:timon']);
  assert.equal(TERMINAL_ISLAND_CONTENT, '@timon/terminal-web:session');
});

test('text to insert is queued before the island is shown, and never sent by this module', async () => {
  const log: string[] = [];
  await openTerminalSession(scope, { insert: 'npm test' }, deps(ok([shell('a', 'project:timon')]), log));
  assert.deepEqual(log, ['insert:a:npm test', 'show:a:project:timon']);
});

test('a disabled terminal says why and starts nothing', async () => {
  const log: string[] = [];
  const out = await openTerminalSession(scope, {}, deps({ enabled: false, reason: 'pty_unavailable', sessions: [] }, log));
  assert.deepEqual(out, { kind: 'unavailable', reason: 'pty_unavailable' });
  assert.deepEqual(log, []);
});

test('a workspace that refuses leaves the shell running and says so', async () => {
  const out = await openTerminalSession(scope, {}, deps(ok([shell('a', 'project:timon')]), [], false));
  assert.deepEqual(out, { kind: 'refused', sessionId: 'a' });
});

// TODO #649: "Paste into a terminal" from a multichat cell. The grid has no
// project of its own, so the opener refused every card's scope and the user
// only got a toast and the clipboard.
const multichat: OpenView = { state: 'ready', scope: null, key: null };
const timonView: OpenView = { state: 'ready', scope, key: 'project:timon' };
const globex = { kind: 'project', slug: 'globex' } as const;

test('a view of no project takes the scope a card names: the multichat cell opens its own project\'s shells', () => {
  assert.deepEqual(openScope(multichat, scope), { scope });
  assert.deepEqual(openScope(multichat, globex), { scope: globex });
  assert.deepEqual(openScope(multichat, { kind: 'agent', name: 'solo' }), { scope: { kind: 'agent', name: 'solo' } });
  assert.deepEqual(openScope(multichat, null), { scope: null });
});

test('a request naming no scope, or the view\'s own, opens the view\'s shells', () => {
  assert.deepEqual(openScope(timonView, undefined), { scope });
  assert.deepEqual(openScope(timonView, { kind: 'project', slug: 'timon' }), { scope });
  assert.deepEqual(openScope(multichat, undefined), { scope: null });
});

test('another project\'s request is refused on a project\'s view, and anything while the view resolves', () => {
  assert.equal(openScope(timonView, globex), null);
  assert.equal(openScope(timonView, null), null);
  assert.equal(openScope({ state: 'ready', scope: { kind: 'agent', name: 'solo' }, key: 'agent:solo' }, scope), null);
  assert.equal(openScope({ state: 'pending' }, scope), null);
  assert.equal(openScope({ state: 'pending' }, undefined), null);
});

test('pasted from a multichat cell: the shell of the card\'s project is found or started, never a project-less one', async () => {
  const log: string[] = [];
  const target = openScope(multichat, scope);
  assert.ok(target);
  const sessions = [shell('none', null), shell('t1', 'project:timon')];
  const outcome = await openTerminalSession(target.scope, { insert: 'npm test' }, deps(ok(sessions), log));
  assert.deepEqual(outcome, { kind: 'opened', sessionId: 't1' });
  assert.deepEqual(log, ['insert:t1:npm test', 'show:t1:project:timon']);

  const fresh: string[] = [];
  await openTerminalSession(target.scope, { insert: 'ls' }, deps(ok([shell('none', null)]), fresh));
  assert.deepEqual(fresh, ['create:-:scoped', 'insert:new1:ls', 'show:new1:project:timon']);
});
