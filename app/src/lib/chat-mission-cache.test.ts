/**
 * The cache of the conversations a chat showed last (chat-mission-cache.ts):
 * least recently used first out, bounded by count and by size, forgotten on
 * demand, served to the account it was read for only, and the reading of a
 * delta answer.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chatCacheEpoch, chatMissionCacheContents, forgetAllChatMissions, forgetChatMission, getCachedChatMission,
  hasCachedChatMission, historyDeltaUrl, newestEventId, parseHistoryDelta, putCachedChatMission,
} from './chat-mission-cache';
import { announceAccount } from './account-change';

beforeEach(() => announceAccount('user-a'));
afterEach(() => {
  forgetAllChatMissions();
  announceAccount(null);
});

const entry = (lastEventId: number, bytes = 10) => ({ lastEventId, bytes, state: { label: `s${lastEventId}` } });

test('a change of account forgets every conversation the tab held', () => {
  putCachedChatMission('a', entry(1));
  putCachedChatMission('b', entry(2));
  forgetAllChatMissions();
  assert.equal(getCachedChatMission('a'), null);
  assert.equal(getCachedChatMission('b'), null);
  assert.deepEqual(chatMissionCacheContents(), { ids: [], bytes: 0 });
});

test('an entry read for one account is never served to another (TODO #500)', () => {
  putCachedChatMission('a', entry(1));
  // Another tab signed in as B; this one learns it from the next resolution.
  announceAccount('user-b');
  assert.equal(hasCachedChatMission('a'), false);
  assert.equal(getCachedChatMission('a'), null);
  assert.deepEqual(chatMissionCacheContents(), { ids: [], bytes: 0 });
});

test('nothing is cached nor served while the account is unknown', () => {
  putCachedChatMission('a', entry(1));
  announceAccount(null);
  assert.equal(getCachedChatMission('a'), null);
  assert.equal(putCachedChatMission('b', entry(2)), false);
  assert.deepEqual(chatMissionCacheContents(), { ids: [], bytes: 0 });
});

test('a conversation built under one account is not put back under the next', () => {
  const before = chatCacheEpoch();
  announceAccount('user-b');
  assert.equal(putCachedChatMission('a', entry(1), { epoch: before }), false);
  assert.equal(putCachedChatMission('a', entry(1), { epoch: chatCacheEpoch() }), true);
});

test('naming the account for the first time keeps what was built', () => {
  announceAccount(null);
  const before = chatCacheEpoch();
  announceAccount('user-a');
  assert.equal(chatCacheEpoch(), before);
});

test('a purge in another tab empties this one, and this one tells the others', async () => {
  putCachedChatMission('a', entry(1));
  const otherTab = new BroadcastChannel('timon-chat-cache');
  try {
    const heard = new Promise<unknown>((resolve) => { otherTab.onmessage = (event) => resolve(event.data); });
    forgetAllChatMissions();
    assert.equal(await heard, 'purge');

    putCachedChatMission('b', entry(2));
    const epoch = chatCacheEpoch();
    otherTab.postMessage('purge');
    for (let i = 0; i < 50 && chatCacheEpoch() === epoch; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.notEqual(chatCacheEpoch(), epoch, 'the other tab\'s purge did not arrive');
    assert.deepEqual(chatMissionCacheContents(), { ids: [], bytes: 0 });
  } finally {
    otherTab.close();
  }
});

test('a conversation built before the purge is not put back after it', () => {
  const before = chatCacheEpoch();
  forgetAllChatMissions();
  assert.notEqual(chatCacheEpoch(), before);
  assert.equal(putCachedChatMission('a', entry(1), { epoch: before }), false);
  assert.deepEqual(chatMissionCacheContents(), { ids: [], bytes: 0 });
  assert.equal(putCachedChatMission('a', entry(1), { epoch: chatCacheEpoch() }), true);
});

// Logout navigates softly: the module survives for the next account unless
// the purge runs before the navigation. Login reloads, but purges first too.
test('logout and a new session purge the cache before they navigate', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const [file, navigation] of [
    [join(src, 'components', 'settings', 'settings-account.tsx'), "router.replace('/login')"],
    [join(src, 'app', 'login', 'page.tsx'), 'window.location.replace(target)'],
  ] as const) {
    const code = readFileSync(file, 'utf8');
    const purge = code.indexOf('forgetAllChatMissions()');
    assert.ok(purge >= 0, `${file} does not purge the chat cache`);
    assert.ok(purge < code.indexOf(navigation), `${file} navigates before the purge`);
  }
});

test('an entry comes back as it was put, and a get makes it the most recent', () => {
  putCachedChatMission('a', entry(1));
  putCachedChatMission('b', entry(2));
  assert.deepEqual(getCachedChatMission<{ label: string }>('a'), entry(1));
  assert.deepEqual(chatMissionCacheContents().ids, ['b', 'a']);
  assert.equal(getCachedChatMission('nope'), null);
  assert.equal(hasCachedChatMission('b'), true);
});

test('past the count, the least recently used goes first', () => {
  for (const id of ['a', 'b', 'c']) putCachedChatMission(id, entry(1), { maxEntries: 3 });
  getCachedChatMission('a');
  putCachedChatMission('d', entry(1), { maxEntries: 3 });
  assert.deepEqual(chatMissionCacheContents().ids, ['c', 'a', 'd']);
});

test('past the size, the oldest go until the rest fits; one too large is not kept', () => {
  putCachedChatMission('a', entry(1, 40), { maxBytes: 100 });
  putCachedChatMission('b', entry(1, 40), { maxBytes: 100 });
  putCachedChatMission('c', entry(1, 40), { maxBytes: 100 });
  assert.deepEqual(chatMissionCacheContents(), { ids: ['b', 'c'], bytes: 80 });
  assert.equal(putCachedChatMission('huge', entry(1, 101), { maxBytes: 100 }), false);
  assert.deepEqual(chatMissionCacheContents(), { ids: ['b', 'c'], bytes: 80 });
});

test('putting a mission again replaces its entry and its size', () => {
  putCachedChatMission('a', entry(1, 40));
  putCachedChatMission('a', entry(9, 15));
  assert.deepEqual(chatMissionCacheContents(), { ids: ['a'], bytes: 15 });
  assert.equal(getCachedChatMission('a')?.lastEventId, 9);
});

test('a forgotten mission is gone, with its size', () => {
  putCachedChatMission('a', entry(1, 40));
  putCachedChatMission('b', entry(1, 5));
  forgetChatMission('a');
  forgetChatMission('never');
  assert.deepEqual(chatMissionCacheContents(), { ids: ['b'], bytes: 5 });
});

test('the newest id of a read, rows without an id ignored', () => {
  assert.equal(newestEventId([{ id: 3 }, { id: null }, { id: 7 }, { id: 5 }]), 7);
  assert.equal(newestEventId([], 4), 4);
  assert.equal(newestEventId([{ id: 2 }], 4), 4);
});

test('a delta answer: rows, a reset, or a daemon that ignored the cursor', () => {
  assert.deepEqual(parseHistoryDelta({ events: [], reset: false, newest_event_id: 12 }), { reset: false, newestId: 12 });
  assert.deepEqual(parseHistoryDelta({ events: [], reset: false, newest_event_id: null }), { reset: false, newestId: null });
  assert.equal(parseHistoryDelta({ events: [], reset: true, newest_event_id: null }).reset, true);
  assert.equal(parseHistoryDelta({ events: [{ id: 1 }] }).reset, true, 'no cursor in the answer: the whole journal came back');
  assert.equal(parseHistoryDelta(null).reset, true);
  assert.equal(historyDeltaUrl('a b', 42), '/api/ui/missions/a%20b?after=42');
});
