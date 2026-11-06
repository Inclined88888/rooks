/**
 * The tab's single Git state (TODO #278, volet 1).
 *
 * WHY: the Git panel, the publication panel and the composer's branch each
 * kept their own clock (polls of 30 s and 15 s, plus a third 30 s poll in the
 * chat). After a checkout, the panel moved while the composer kept showing the
 * old branch until a page reload. Here the three reads share ONE invalidation:
 * an action (checkout, push, fetch), the end of a turn, or the tab coming back
 * into view refetches every read on screen at once. No timer polls the daemon,
 * and a tab in the background reads nothing.
 *
 * One resource per question the daemon answers:
 * - `dashboard` (`/api/ui/git?slug=`): the project checkout — branches,
 *   worktree marks, ahead/behind, working tree;
 * - `remote` (`/api/ui/git-remote/:slug`): publication state;
 * - `agent` (`/api/ui/agents/:name/git?slug=`): the AGENT's cwd, which may be
 *   a worktree and so legitimately on another branch than the project
 *   checkout, or another repository altogether (`foreignRepo`, `agentGitId`);
 * - `log` (`/api/ui/git/log?slug=`) and `worktrees` (`/api/ui/git/worktrees?slug=`):
 *   the commit graph of the Git widget, read only while it is on screen;
 * - `repos` (`/api/ui/git/repos?slug=`): the repositories of the project, the
 *   root first, then the nested ones (TODO #923).
 *
 * `dashboard`, `remote`, `log` and `worktrees` read one repository of the
 * project: their id is `gitRepoId(slug, repo)`, the bare slug for the root.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { onAccountChange } from './account-change';
import { sseOn } from './sse-stream';
import { apiErrorMessage } from '@/lib/api-error';

export type GitDashboardBranch = {
  name: string;
  current: boolean;
  merged: boolean;
  ahead: number;
  behind: number;
  lastCommitTs: number;
  lastCommitSubject: string;
  worktree: boolean;
};

export type GitDashboard = {
  ok: boolean;
  repo: string | null;
  base: string | null;
  currentBranch: string | null;
  branches: GitDashboardBranch[];
  staged: string[];
  unstaged: string[];
  untracked: string[];
  error?: string;
};

export type GitRemoteState =
  | 'no-cwd'
  | 'not-a-repo'
  | 'no-remote'
  | 'no-upstream'
  | 'ahead'
  | 'synced';

export type GitRemoteBranch = {
  name: string;
  upstream: string | null;
  compare_ref: string | null;
  ahead: number | null;
  behind: number | null;
  published: boolean;
};

export type GitRemote = {
  slug: string;
  state: GitRemoteState;
  cwd: string | null;
  branch: string | null;
  remote_name: string | null;
  remote_count: number;
  remote: string | null;
  remote_web: string | null;
  upstream: string | null;
  compare_ref: string | null;
  branch_published: boolean;
  ahead: number | null;
  behind: number | null;
  dirty: number | null;
  has_commits: boolean;
  last_commit_at: number | null;
  fetched_at: number | null;
  gh_available: boolean;
  gh_account: string | null;
  default_repo_name: string | null;
  branches: GitRemoteBranch[];
  /** Every remote with what each branch lacks there; absent from a daemon
   *  older than the push destination picker. */
  remotes?: GitRemoteTarget[];
};

/** One remote a push can target, and what each listed branch lacks there. */
export type GitRemoteTarget = {
  name: string;
  /** Push url, credentials masked. */
  url: string | null;
  web: string | null;
  /** `published: false` = the branch is absent from that remote. */
  branches: Array<{ name: string; published: boolean; ahead: number | null }>;
};

/** One configured remote; the daemon masks any credentials in its urls. */
export type GitRemoteEntry = { name: string; url: string | null; push_url: string | null };

/** What the daemon answers after adding, changing or removing a remote.
 *  `check` is git's attempt to reach it, null when none was made. */
export type GitRemoteChange = {
  git: GitRemote;
  remotes: GitRemoteEntry[];
  check: { ok: true } | { ok: false; error: string } | null;
};

/** A ref decorating a commit; `head` is HEAD itself, attached or detached. */
export type GitRef = { kind: 'head' | 'branch' | 'remote' | 'tag'; name: string };

export type GitCommit = {
  hash: string;
  short: string;
  /** Full shas, first parent first; a parent may be past the page read. */
  parents: string[];
  author: string;
  /** Author date, ms epoch. */
  ts: number;
  subject: string;
  refs: GitRef[];
};

export type GitLog = {
  ok: boolean;
  repo: string | null;
  head: string | null;
  currentBranch: string | null;
  /** Older commits exist past the ones returned. */
  truncated: boolean;
  commits: GitCommit[];
  error?: string;
};

export type GitWorktree = {
  path: string;
  head: string | null;
  branch: string | null;
  main: boolean;
  current: boolean;
  bare: boolean;
  detached: boolean;
  locked: string | null;
  prunable: string | null;
};

export type GitWorktreeList = {
  ok: boolean;
  repo: string | null;
  worktrees: GitWorktree[];
  error?: string;
};

/** One repository of a project; `path` is relative to the project folder,
 *  `''` for the root. */
export type GitRepo = { path: string; name: string };

/** Id of a read on one repository of `slug`. The root keeps the bare slug, so
 *  every reader that knows nothing of nested repositories shares its entry.
 *  A `#` cannot occur in a slug: the first one splits the two. */
export function gitRepoId(slug: string, repo: string | null | undefined): string {
  return repo ? `${slug}#${repo}` : slug;
}

function splitRepoId(id: string): { slug: string; repo: string | null } {
  const cut = id.indexOf('#');
  return cut === -1 ? { slug: id, repo: null } : { slug: id.slice(0, cut), repo: id.slice(cut + 1) };
}

/** Commits the graph reads: enough to see the branches of a working week,
 *  few enough for one SVG drawn without virtualisation. */
export const GIT_LOG_LIMIT = 150;

export type AgentGitInfo = {
  branch: string | null;
  dirty: boolean;
  worktree: string | null;
  /** Lines added / removed in tracked files against HEAD. Absent from a
   *  daemon older than the composer's picker. */
  added?: number;
  removed?: number;
  /** Asked with a project: the cwd is a repository other than the project's.
   *  Absent without a project, or from a daemon older than TODO #429. */
  foreignRepo?: boolean;
};

/** Id of an `agent` read. With the project the picker switches, the daemon
 *  also says whether the agent's folder is that project's repository: two
 *  folders are compared there, after realpath, never here as text. A `?`
 *  cannot occur in an agent name (the route refuses it). */
export function agentGitId(name: string, slug: string | null): string {
  return slug ? `${name}?${slug}` : name;
}

type DataOf = {
  dashboard: GitDashboard;
  remote: GitRemote;
  agent: AgentGitInfo;
  log: GitLog;
  worktrees: GitWorktreeList;
  repos: GitRepo[];
};
export type GitResource = keyof DataOf;

export type GitSnapshot<T> = {
  data: T | null;
  /** Last failure of the `dashboard` or `log` read; the others fail silently:
   *  a hiccup must not blank a branch already shown. */
  error: string | null;
  loading: boolean;
};

const EMPTY: GitSnapshot<never> = Object.freeze({ data: null, error: null, loading: false });

/**
 * Burst guard for the GLOBAL stream: every mission of the machine ends turns
 * on it, and a night of parallel tasks would otherwise chain `git` reads
 * back to back — the dashboard read walks every branch, and the repo of this
 * very product carries one per task. A gesture of the user, or the end of the
 * shown chat's own turn, goes through `invalidateGit` and is never delayed.
 */
const AMBIENT_MIN_MS = 10_000;

type Outcome = { data?: unknown; error?: string | null; gone?: boolean };

type Entry = {
  resource: GitResource;
  id: string;
  snap: GitSnapshot<unknown>;
  serialized: string;
  listeners: Set<() => void>;
  inFlight: boolean;
  /** Invalidated while a read was in flight: that answer may predate the
   *  change (a checkout), so it is dropped and the read runs again. */
  dirty: boolean;
  /** The agent no longer exists (404): events stop asking for it. */
  gone: boolean;
};

const entries = new Map<string, Entry>();
/** Bumped on account change: an answer read for the previous account is dropped. */
let generation = 0;
let subscriberCount = 0;
let detachTriggers: (() => void) | null = null;
let ambientTimer: ReturnType<typeof setTimeout> | null = null;
let lastAmbient = 0;

const keyOf = (resource: GitResource, id: string) => `${resource}:${id}`;

function urlOf(resource: GitResource, id: string): string {
  if (resource === 'repos') return `/api/ui/git/repos?slug=${encodeURIComponent(id)}`;
  if (resource !== 'agent') {
    const { slug, repo } = splitRepoId(id);
    const enc = encodeURIComponent(slug);
    const r = repo ? `repo=${encodeURIComponent(repo)}` : '';
    if (resource === 'dashboard') return `/api/ui/git?slug=${enc}${r && `&${r}`}`;
    if (resource === 'remote') return `/api/ui/git-remote/${enc}${r && `?${r}`}`;
    if (resource === 'log') return `/api/ui/git/log?slug=${enc}&limit=${GIT_LOG_LIMIT}${r && `&${r}`}`;
    return `/api/ui/git/worktrees?slug=${enc}${r && `&${r}`}`;
  }
  const enc = encodeURIComponent(id);
  const cut = id.indexOf('?');
  if (cut === -1) return `/api/ui/agents/${enc}/git`;
  const name = encodeURIComponent(id.slice(0, cut));
  return `/api/ui/agents/${name}/git?slug=${encodeURIComponent(id.slice(cut + 1))}`;
}

async function read(resource: GitResource, id: string): Promise<Outcome> {
  try {
    const r = await fetch(urlOf(resource, id), { cache: 'no-store' });
    if (resource === 'agent' && r.status === 404) return { data: null, gone: true };
    const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (resource === 'dashboard' || resource === 'log') {
      if (!r.ok) return { error: apiErrorMessage(body, { status: r.status }) };
      return { data: body, error: null };
    }
    // A missed read of the other two keeps the last known state: a hiccup
    // must not blank the composer's branch or the publication card.
    if (!r.ok || !body) return {};
    if (resource === 'remote') return body.git ? { data: body.git } : {};
    if (resource === 'repos') return Array.isArray(body.repos) ? { data: body.repos } : {};
    return { data: body };
  } catch (e) {
    return resource === 'dashboard' || resource === 'log' ? { error: String(e) } : {};
  }
}

function publish(e: Entry, next: GitSnapshot<unknown>): void {
  // Identity stays put while nothing changed: `useSyncExternalStore` compares
  // by reference, and a fresh object per read would re-render every reader.
  const serialized = JSON.stringify(next);
  if (serialized === e.serialized) return;
  e.serialized = serialized;
  e.snap = next;
  for (const fn of e.listeners) fn();
}

function apply(e: Entry, out: Outcome): void {
  if (out.gone) e.gone = true;
  let data = 'data' in out ? out.data ?? null : e.snap.data;
  // Same content, same object: a reader's effect keyed on `data` (the
  // publication card's branch choice) must not rerun on a read that changed
  // nothing.
  if (data !== e.snap.data && JSON.stringify(data) === JSON.stringify(e.snap.data)) data = e.snap.data;
  publish(e, {
    data,
    error: 'error' in out ? out.error ?? null : e.snap.error,
    loading: false,
  });
}

function run(e: Entry): void {
  if (e.inFlight) { e.dirty = true; return; }
  e.inFlight = true;
  e.dirty = false;
  const gen = generation;
  publish(e, { ...e.snap, loading: true });
  void read(e.resource, e.id).then((out) => {
    if (gen !== generation || entries.get(keyOf(e.resource, e.id)) !== e) return;
    e.inFlight = false;
    if (e.dirty) { run(e); return; }
    apply(e, out);
  });
}

function entryFor(resource: GitResource, id: string): Entry {
  const key = keyOf(resource, id);
  let e = entries.get(key);
  if (!e) {
    e = {
      resource, id, snap: EMPTY, serialized: JSON.stringify(EMPTY),
      listeners: new Set(), inFlight: false, dirty: false, gone: false,
    };
    entries.set(key, e);
  }
  return e;
}

/** Refetches every Git read currently on screen. Call it after any action
 *  that moves the repository: checkout, push, fetch, end of a turn. A read
 *  already in flight may predate the change, so it is replaced. */
export function invalidateGit(): void {
  for (const e of entries.values()) {
    if (e.listeners.size > 0 && !e.gone) run(e);
  }
}

/**
 * Rereads on a hint that something MAY have moved (tab back in view, a turn
 * of some other mission): nothing changed on our side, so a read already in
 * flight is as fresh as a new one and is kept. `focus` and `visibilitychange`
 * fire together on return to the tab: one read each, not two.
 */
export function revalidateGit(): void {
  for (const e of entries.values()) {
    if (e.listeners.size > 0 && !e.gone && !e.inFlight) run(e);
  }
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Writes the state an action answered with (`push`, `fetch`, `create-remote`
 *  return the fresh publication state), so the card does not wait for a read.
 *  `id` is `gitRepoId(slug, repo)`: the bare slug for the project root. */
export function setGitRemote(id: string, git: GitRemote): void {
  const e = entryFor('remote', id);
  // A read that left before the action would bring the old state back.
  if (e.inFlight) e.dirty = true;
  publish(e, { data: git, error: e.snap.error, loading: e.snap.loading });
}

function ambient(): void {
  // A tab left open in the background reads nothing: coming back to it
  // (`visibilitychange`) catches up in one go.
  if (ambientTimer || hidden()) return;
  const wait = Math.max(0, lastAmbient + AMBIENT_MIN_MS - Date.now());
  ambientTimer = setTimeout(() => {
    ambientTimer = null;
    if (hidden()) return;
    lastAmbient = Date.now();
    revalidateGit();
  }, wait);
}

function attachTriggers(): () => void {
  const unsubs = [sseOn('turn_complete', ambient), sseOn('mission_complete', ambient)];
  // A checkout typed in a terminal reaches no stream: coming back to the tab
  // is the moment the user looks again, so that is when the state is reread.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const onVisible = () => { if (!hidden()) revalidateGit(); };
    window.addEventListener('focus', revalidateGit);
    document.addEventListener('visibilitychange', onVisible);
    unsubs.push(() => {
      window.removeEventListener('focus', revalidateGit);
      document.removeEventListener('visibilitychange', onVisible);
    });
  }
  return () => {
    for (const u of unsubs) u();
    if (ambientTimer) { clearTimeout(ambientTimer); ambientTimer = null; }
  };
}

export function subscribeGit(resource: GitResource, id: string, listener: () => void): () => void {
  const e = entryFor(resource, id);
  const first = e.listeners.size === 0;
  e.listeners.add(listener);
  subscriberCount += 1;
  if (!detachTriggers) detachTriggers = attachTriggers();
  // The first reader of a key reads it, even with a cached answer: the cache
  // shows at once, the read brings it up to date. Further readers share both.
  if (first && !e.gone) run(e);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    e.listeners.delete(listener);
    subscriberCount -= 1;
    if (subscriberCount === 0 && detachTriggers) { detachTriggers(); detachTriggers = null; }
  };
}

export function getGitSnapshot<R extends GitResource>(resource: R, id: string): GitSnapshot<DataOf[R]> {
  return (entries.get(keyOf(resource, id))?.snap ?? EMPTY) as GitSnapshot<DataOf[R]>;
}

// The Git state of one account is not the next one's: their projects differ.
onAccountChange(() => {
  generation += 1;
  for (const [key, e] of entries) {
    e.inFlight = false;
    e.dirty = false;
    e.gone = false;
    if (e.listeners.size === 0) { entries.delete(key); continue; }
    publish(e, EMPTY);
    run(e);
  }
});

/** Reads one resource; `id` null = nothing to read (module off, no project). */
export function useGit<R extends GitResource>(resource: R, id: string | null): GitSnapshot<DataOf[R]> {
  const subscribe = useCallback(
    (listener: () => void) => (id ? subscribeGit(resource, id, listener) : () => {}),
    [resource, id],
  );
  const snapshot = useCallback(
    () => (id ? getGitSnapshot(resource, id) : (EMPTY as GitSnapshot<DataOf[R]>)),
    [resource, id],
  );
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY as GitSnapshot<DataOf[R]>);
}
