/**
 * The conversations a chat showed last, kept in memory so that coming back to
 * one paints it at once (docs/CHAT-MISSION-CACHE.md).
 *
 * Switching agent re-keys `ChatClient`, and a new one used to read the tail
 * page and replay it in full, even for a chat left a second ago. A leaving
 * chat now puts what it built here: its messages and derived state, and the
 * id of the newest journal row it read. `bindMission` paints from the entry in
 * the same frame, then asks the daemon for the rows after that id
 * (`GET /api/missions/:id?after=`) and replays only those.
 *
 * Module-level and least-recently-used, after `mission-spans.ts`; bounded by
 * a count and by a size, the size being what the daemon sent to build the
 * entry (bodies of the pages, the delta and the live stream), a stand-in for
 * the memory the messages hold.
 *
 * Every entry names the account it was read for and is served to that account
 * only: a thread is private content (AGENTS.md rule 8), and the tab may not be
 * the one where the account changed (TODO #500).
 */

import { currentAccount, onAccountChange } from './account-change';

export const CHAT_CACHE_MISSIONS = 6;
/** Characters of journal behind every entry together. */
export const CHAT_CACHE_MAX_BYTES = 24 * 1024 * 1024;

export interface ChatMissionCacheEntry<S> {
  /** Newest journal row the state holds: the `after` of the next delta. */
  lastEventId: number;
  bytes: number;
  state: S;
}

/** What the cache holds: the entry and the account it was read for. */
interface HeldEntry {
  account: string;
  entry: ChatMissionCacheEntry<unknown>;
}

const entries = new Map<string, HeldEntry>();
let totalBytes = 0;
/**
 * Bumped by every purge on a change of account. A chat holds the value it
 * started building under and writes nothing once it moved: the unmount that
 * follows a logout would otherwise put the previous account's thread back.
 */
let accountEpoch = 0;

/** The current account epoch, to capture when a chat starts building. */
export function chatCacheEpoch(): number {
  return accountEpoch;
}

function drop(missionId: string): void {
  const held = entries.get(missionId);
  if (!held) return;
  totalBytes -= held.entry.bytes;
  entries.delete(missionId);
}

/**
 * The entry of `missionId` if the account signed in now is the one it was read
 * for. Unknown account: nothing is served. Another account: the entry is
 * dropped, it can never be served again.
 */
function heldForCurrentAccount(missionId: string): HeldEntry | null {
  const held = entries.get(missionId);
  if (!held) return null;
  const account = currentAccount();
  if (account === null) return null;
  if (held.account !== account) {
    drop(missionId);
    return null;
  }
  return held;
}

/** The entry of `missionId`, now the most recently used; `null` when none. */
export function getCachedChatMission<S>(missionId: string): ChatMissionCacheEntry<S> | null {
  const held = heldForCurrentAccount(missionId);
  if (!held) return null;
  entries.delete(missionId);
  entries.set(missionId, held);
  // The one place the stored type is restored: each chat keeps its own shape.
  return held.entry as ChatMissionCacheEntry<S>;
}

export function hasCachedChatMission(missionId: string): boolean {
  return heldForCurrentAccount(missionId) !== null;
}

/**
 * Keeps `entry` as the most recent, evicting the oldest past either bound.
 * An entry larger than the whole budget is not kept: it would evict the rest
 * for a conversation that is cheaper to read again than to hold. An `epoch`
 * other than the current one (`chatCacheEpoch()`) is refused: the entry was
 * built for an account that is gone. So is any entry while the account is not
 * known yet: it could not be tied to one.
 */
export function putCachedChatMission<S>(
  missionId: string,
  entry: ChatMissionCacheEntry<S>,
  { maxEntries = CHAT_CACHE_MISSIONS, maxBytes = CHAT_CACHE_MAX_BYTES, epoch }:
    { maxEntries?: number; maxBytes?: number; epoch?: number } = {},
): boolean {
  if (epoch !== undefined && epoch !== accountEpoch) return false;
  const account = currentAccount();
  drop(missionId);
  if (account === null || entry.bytes > maxBytes) return false;
  entries.set(missionId, { account, entry });
  totalBytes += entry.bytes;
  while (entries.size > maxEntries || totalBytes > maxBytes) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined || oldest === missionId) break;
    drop(oldest);
  }
  return true;
}

/** A mission killed, deleted, or whose delta asked for a reset. */
export function forgetChatMission(missionId: string): void {
  drop(missionId);
}

function purge(): void {
  accountEpoch += 1;
  entries.clear();
  totalBytes = 0;
}

/**
 * The other tabs of this browser share the session cookie: a login or a
 * logout here changes their account too, without their knowing. Each tab
 * listens on this channel and purges when another one does.
 */
const ACCOUNT_CHANNEL = 'rooks-chat-cache';
let channel: BroadcastChannel | null = null;

function accountChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  try {
    channel = new BroadcastChannel(ACCOUNT_CHANNEL);
  } catch {
    return null;
  }
  channel.onmessage = () => purge();
  // Node (tests) keeps a listening channel's process alive; a browser has no `unref`.
  (channel as BroadcastChannel & { unref?: () => void }).unref?.();
  return channel;
}
accountChannel();

/**
 * Every conversation, on a change of account (logout, new session), in this
 * tab and in the other tabs of the browser. Chats still mounted lose the
 * right to write (`accountEpoch`).
 */
export function forgetAllChatMissions(): void {
  purge();
  try {
    accountChannel()?.postMessage('purge');
  } catch {
    // A closed channel: the account key still keeps the entries to their account.
  }
}

// The account resolved in this tab changed (another owner, the login page):
// what was built before can no longer be put back. Naming the account for the
// first time is no change.
let followedAccount: string | null = currentAccount();
onAccountChange((owner) => {
  if (followedAccount !== null && owner !== followedAccount) purge();
  followedAccount = owner;
});

/** Tests only: the ids held, oldest first, and their total size. */
export function chatMissionCacheContents(): { ids: string[]; bytes: number } {
  return { ids: [...entries.keys()], bytes: totalBytes };
}

/** The newest row id of a list read from the journal, or `previous`. */
export function newestEventId(events: readonly { id: number | null }[], previous: number | null = null): number | null {
  let newest = previous;
  for (const event of events) {
    if (typeof event.id === 'number' && (newest === null || event.id > newest)) newest = event.id;
  }
  return newest;
}

/**
 * What `?after=` answered: the rows to replay, or `reset` (rebuild from the
 * tail). A daemon older than the cursor ignores it and sends the whole
 * journal without `newest_event_id`: replayed over the cache, its older rows
 * would land at the bottom of the thread, so that is a reset too.
 */
export function parseHistoryDelta(raw: unknown): { reset: boolean; newestId: number | null } {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    reset: body.reset === true || !('newest_event_id' in body),
    newestId: typeof body.newest_event_id === 'number' ? body.newest_event_id : null,
  };
}

export function historyDeltaUrl(missionId: string, after: number): string {
  return `/api/ui/missions/${encodeURIComponent(missionId)}?after=${after}`;
}
