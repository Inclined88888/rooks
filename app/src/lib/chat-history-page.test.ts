import assert from 'node:assert/strict';
import test from 'node:test';
import {
  belowHistoryFloor, CHAT_HISTORY_PAGE, contextWindowsWithShortKeys, cursorAfterPage, historyPageUrl,
  mergeOlderMessages, NO_HISTORY, parseHistoryEvents, parseHistoryPrelude,
} from './chat-history-page';
import { missionDetailUrl } from './chat-mission-preload';

test('the bind reads the last page, an older read names its cursor', () => {
  assert.equal(historyPageUrl('m 1', null), `/api/ui/missions/m%201?tail=${CHAT_HISTORY_PAGE}`);
  assert.equal(historyPageUrl('m1', 42, 10), '/api/ui/missions/m1?tail=10&before=42');
  assert.equal(missionDetailUrl('m1'), historyPageUrl('m1', null), 'the preload asks what the bind asks');
});

test('a prelude is read defensively, bad fields falling back to empty', () => {
  const prelude = parseHistoryPrelude({
    session_id: 'sess', backend: 'claude', model: 'sonnet', observed_model: null,
    stats: { tok: 12, cost: 0.5 }, totals: { in: 10, out: 'x' },
    context_windows: { a: 200000, b: -1, c: 'big' },
    last_context_tokens: 99, last_human_text: '',
    todo_tool_uses: [{ id: 't1', name: 'TodoWrite', input: { todos: [] } }, { name: 42 }, null],
    events: [{ id: 1, type: 'permission_request', timestamp: 5, payload: { id: 'p' } }, { id: 'x' }, { type: 'user', timestamp: 6, payload: {} }],
  });
  assert.ok(prelude);
  assert.equal(prelude.sessionId, 'sess');
  assert.equal(prelude.observedModel, null);
  assert.deepEqual(prelude.stats, { tok: 12, cost: 0.5 });
  assert.deepEqual(prelude.totals, { in: 10, out: 0 });
  assert.deepEqual(prelude.contextWindows, { a: 200000 });
  assert.equal(prelude.lastHumanText, null);
  assert.deepEqual(prelude.todoToolUses, [{ id: 't1', name: 'TodoWrite', input: { todos: [] } }]);
  assert.deepEqual(prelude.events.map((e) => e.id), [1, null], 'a row without type is dropped, one without id is kept');
  assert.equal(parseHistoryPrelude(undefined), null, 'an unpaged response has none');
  assert.deepEqual(parseHistoryEvents('nope'), []);
});

test('the cursor follows has_more and the oldest row; an empty page keeps the previous floor', () => {
  const events = parseHistoryEvents([{ id: 7, type: 'user', timestamp: 700, payload: {} }]);
  const cursor = cursorAfterPage({ has_more: true, oldest_event_id: 5 }, events);
  assert.deepEqual(cursor, { oldestId: 5, oldestAt: 700, hasMore: true });
  assert.deepEqual(cursorAfterPage({ has_more: false, oldest_event_id: null }, [], cursor), { oldestId: 5, oldestAt: 700, hasMore: false });
  assert.deepEqual(cursorAfterPage({ events: [] }, []), NO_HISTORY, 'an unpaged response has nothing more');
});

test('a live row below the loaded history is left to its page', () => {
  const cursor = { oldestId: 5, oldestAt: 700, hasMore: true };
  assert.equal(belowHistoryFloor(699, cursor), true);
  assert.equal(belowHistoryFloor(700, cursor), false, 'the same millisecond is kept (dedup decides)');
  assert.equal(belowHistoryFloor(1, { ...cursor, hasMore: false }), false, 'everything is loaded: nothing is below');
  assert.equal(belowHistoryFloor(1, NO_HISTORY), false);
});

test('older messages go above; a card in both moves to its place with the newer state', () => {
  const older = [{ id: 'a', v: 1 }, { id: 'perm:p', v: 'pending' }, { id: 'b', v: 1 }];
  const current = [{ id: 'perm:p', v: 'allowed' }, { id: 'c', v: 2 }];
  assert.deepEqual(mergeOlderMessages(older, current), [{ id: 'a', v: 1 }, { id: 'perm:p', v: 'allowed' }, { id: 'b', v: 1 }, { id: 'c', v: 2 }]);
  assert.equal(mergeOlderMessages([], current), current, 'nothing older: the same list');
});

test('context windows are also indexed under their short slug', () => {
  assert.deepEqual(
    contextWindowsWithShortKeys({ 'claude-sonnet-4-5-20250929': 200000 }, (slug) => slug.replace(/-\d{8}$/, '')),
    { 'claude-sonnet-4-5-20250929': 200000, 'claude-sonnet-4-5': 200000 },
  );
});
