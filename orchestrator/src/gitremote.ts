/**
 * A project's git "publication" state: is there a remote, and am I up to date?
 *
 * Context: many local projects are versioned but never pushed — `git init`
 * done, remote never configured. The work then exists on a single disk, and
 * nobody sees it until someone opens a terminal in the right folder. This
 * module makes that fact visible from the UI, and makes the two corrective
 * gestures (create the remote, push) executable in one click.
 *
 * Every read is done on LOCAL refs: no `git fetch` is triggered by a plain
 * status, otherwise a UI poll every 4 s would mean one network call per
 * project. `behind` can therefore be stale — hence the explicit `fetch`
 * action. `ahead`, on the other hand, is always exact: it is the number of
 * unpushed local commits, which is what we are after.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { getHost } from './host/index.js';
import { checkCwd, reportOf, resolveProjectCwd, usableReport, type CwdReport } from './project-cwd.js';
import { checkRemoteUrl, redactUrlCredentials, REMOTE_URL_MESSAGES } from './git-remote-url.js';
import { resolveRepoCwd } from './project-repos.js';

export type GitRemoteState =
  /** project meta with no `cwd`, or one the daemon cannot use (see `cwd_error`) */
  | 'no-cwd'
  /** the cwd is not a git repository */
  | 'not-a-repo'
  /** repository without a single remote → the code only lives on this disk */
  | 'no-remote'
  /** remote present, but the current branch has no upstream */
  | 'no-upstream'
  /** unpushed local commits */
  | 'ahead'
  /** branch aligned with its upstream */
  | 'synced';

export type GitRemoteStatus = CwdReport & {
  slug: string;
  state: GitRemoteState;
  cwd: string | null;
  /** current branch; null on a detached HEAD or a repository with no commit */
  branch: string | null;
  /** name of the publication remote: the one the current branch tracks,
   *  otherwise `origin`, otherwise the single declared remote. Everything
   *  (push, fetch, url, web link) applies to THAT remote — a repository with
   *  two remotes pushes where it compares, not to a hard-coded `origin`. */
  remote_name: string | null;
  /** number of declared remotes — beyond 1, the UI names the one it shows,
   *  otherwise the line is ambiguous on a repository with two remotes */
  remote_count: number;
  /** url of the publication remote, as git stores it (ssh or https), its
   *  credentials masked if it was configured with some outside Rooks */
  remote: string | null;
  /** the same remote as a clickable https url, null if it cannot be derived */
  remote_web: string | null;
  /** upstream ref of the current branch, e.g. `origin/main` */
  upstream: string | null;
  /** remote ref that ahead/behind are counted against — the upstream if there
   *  is one, otherwise a fallback (see buildStatus); null = nothing published */
  compare_ref: string | null;
  /** does the current branch exist on the remote? false = `ahead` is a gap
   *  against the default branch, NOT a "left to push": none of its commits are
   *  published. Always false on a detached HEAD. */
  branch_published: boolean;
  /** unpushed local commits (exact) */
  ahead: number | null;
  /** remote commits not integrated — computed on local refs, hence stale as
   *  long as no `fetch` has run */
  behind: number | null;
  /** uncommitted entries (`git status --porcelain`) */
  dirty: number | null;
  /** false = repository without a single commit: nothing to push, and `gh repo
   *  create --push` would fail */
  has_commits: boolean;
  /** date of the last local commit, epoch ms */
  last_commit_at: number | null;
  /** date of the last `git fetch` (mtime of FETCH_HEAD), epoch ms */
  fetched_at: number | null;
  /** `gh` CLI available → the create button has a chance of succeeding */
  gh_available: boolean;
  /** GitHub account the repository would be created under, null if not
   *  authenticated */
  gh_account: string | null;
  /** name that would be proposed for the repository — derived from the folder,
   *  NOT from the ROOKS slug: this is what GitHub will show, it must be visible
   *  before the click */
  default_repo_name: string | null;
  /** local branches selectable for the push — the current one is always
   *  included even outside the ten most recent, so it stays selectable after a
   *  `git branch -m` or in a repository with old branches. */
  branches: GitBranchInfo[];
  /** every declared remote, the publication one included, with what each
   *  listed branch has left to push THERE: the Publish tab can push to a
   *  remote other than the upstream, and must say how much would go out. */
  remotes: GitRemoteTarget[];
};

export type GitRemoteTarget = {
  name: string;
  /** where a push goes: the push url when one is set apart, otherwise the
   *  fetch url; credentials masked */
  url: string | null;
  /** the same remote as a clickable https url, null if it cannot be derived */
  web: string | null;
  /** one entry per branch of `branches`, same order */
  branches: GitRemoteTargetBranch[];
};

export type GitRemoteTargetBranch = {
  name: string;
  /** `<remote>/<branch>` exists locally; false = the branch is absent from
   *  that remote (as of the last fetch or push), so all of it would go out */
  published: boolean;
  /** local commits missing from `<remote>/<branch>`; null when the branch is
   *  absent from the remote or the count did not resolve */
  ahead: number | null;
};

export type GitBranchInfo = {
  name: string;
  /** upstream ref, e.g. `origin/main`; null = tracking never configured */
  upstream: string | null;
  /** remote ref that ahead/behind are counted against: the upstream, otherwise
   *  the remote branch of the same name, otherwise the remote's default
   *  branch; null = nothing comparable (no remote, empty remote) */
  compare_ref: string | null;
  /** local commits pending on THIS branch, counted against `compare_ref`;
   *  null if there is nothing to compare against */
  ahead: number | null;
  /** remote commits not integrated on THIS branch; null if there is nothing to
   *  compare against */
  behind: number | null;
  /** false = branch never published: ALL of its commits exist only on this
   *  disk, whatever `ahead` says (which is then a gap against the default
   *  branch, not a "left to push"). A "0" on an unpublished branch would be
   *  falsely reassuring — the UI must say "not published". */
  published: boolean;
};

/** A git status must never block the UI poll loop. */
const GIT_TIMEOUT_MS = 5000;
/** Network actions (push, repository creation) are slow but bounded. */
const NET_TIMEOUT_MS = 120_000;

type Run = { ok: boolean; out: string; err: string };

/** Asynchronous on purpose: `host.exec` is a `spawnSync`, and a status chains
 *  some twenty git calls — 0.6 s during which the whole daemon (HTTP, SSE,
 *  missions) was frozen, once per poll of the Git widget. */
async function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeout = GIT_TIMEOUT_MS,
  env?: NodeJS.ProcessEnv,
): Promise<Run> {
  // `host.bin` throws when the binary cannot be found; the caller, however,
  // always expects a `Run` — a git status must never throw inside the poll loop.
  try {
    const r = await getHost().execAsync(cmd, args, { cwd, timeout, ...(env ? { env } : {}) });
    return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
  } catch (err) {
    return { ok: false, out: '', err: (err as Error).message };
  }
}

/** What a failed command said, as it said it — except a URL's credentials:
 *  git quotes the remote URL it could not reach. */
function failure(r: Run): string {
  return redactUrlCredentials(r.err || r.out || 'unknown code');
}

/** Command output, or null if the command failed — avoids confusing "no value"
 *  with "empty string". */
async function git(args: string[], cwd: string): Promise<string | null> {
  await acquireGitSlot();
  try {
    const r = await run('git', args, cwd);
    return r.ok ? r.out : null;
  } finally {
    releaseGitSlot();
  }
}

/** Spawning a process is itself synchronous (a fork of the daemon): a status
 *  launching all its reads in the same tick would freeze the event loop for the
 *  sum of the spawns. A few slots keep the parallelism and spread that cost. */
const GIT_READ_SLOTS = 4;
let gitReadsInFlight = 0;
const gitReadQueue: (() => void)[] = [];

function acquireGitSlot(): Promise<void> {
  if (gitReadsInFlight < GIT_READ_SLOTS) {
    gitReadsInFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => gitReadQueue.push(resolve));
}

function releaseGitSlot(): void {
  const next = gitReadQueue.shift();
  // The slot passes straight to the next waiter: the counter does not move.
  if (next) next();
  else gitReadsInFlight--;
}

/** `gh` is looked up only once: its absence does not change during the
 *  process's lifetime, and one `which` per poll and per project would be
 *  needlessly expensive. The promise itself is cached so that concurrent
 *  first statuses share a single probe. */
let ghAvailable: Promise<boolean> | null = null;
function hasGh(): Promise<boolean> {
  if (ghAvailable === null) ghAvailable = run('gh', ['--version'], process.cwd(), GIT_TIMEOUT_MS).then((r) => r.ok);
  return ghAvailable;
}

/** Active GitHub account, read from `gh`'s config rather than through
 *  `gh auth status`: that command makes a network round trip, unacceptable in
 *  a status the UI calls in a loop. The file is enough to display "under which
 *  account" — the authentication truth will be settled by `gh repo create` at
 *  click time. */
function ghAccount(): string | null {
  try {
    const raw = readFileSync(join(homedir(), '.config', 'gh', 'hosts.yml'), 'utf8');
    // Minimal YAML, no dependency: we look for the `user:` key of the first
    // host. A full parser would be a luxury for one display line.
    const m = /^\s+user:\s*(\S+)\s*$/m.exec(raw);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Default GitHub name for a folder: GitHub only accepts `[A-Za-z0-9._-]`,
 *  everything else becomes a dash. */
export function repoNameFor(cwd: string): string {
  return basename(cwd).replace(/[^A-Za-z0-9._-]/g, '-');
}

/** Every remote-tracking ref of the repository, read in ONE `for-each-ref`:
 *  the comparison base of each listed branch is then resolved in memory, where
 *  it used to cost up to five `rev-parse` per branch — forty-odd processes per
 *  status, whose spawns alone froze the event loop. */
type RemoteRefs = {
  /** full names, e.g. `refs/remotes/origin/main` */
  names: Set<string>;
  /** `refs/remotes/<remote>/HEAD` → the full ref it points to */
  heads: Map<string, string>;
};

async function readRemoteRefs(cwd: string): Promise<RemoteRefs> {
  const out = await git(['for-each-ref', '--format=%(refname)|%(symref)', 'refs/remotes/'], cwd);
  const refs: RemoteRefs = { names: new Set(), heads: new Map() };
  for (const line of (out ?? '').split('\n')) {
    if (!line) continue;
    const [name, symref] = line.split('|');
    refs.names.add(name!);
    if (symref) refs.heads.set(name!, symref);
  }
  return refs;
}

/** The remote's default branch, as a short ref (`origin/main`), or null.
 *
 *  Pitfall: a `<remote>/HEAD` symref may point to a ref that does not exist
 *  (`rev-parse --abbrev-ref origin/HEAD` even returns the literal string
 *  `origin/HEAD` when it is not configured at all). So the target must really
 *  resolve, otherwise we fall back on published `main`/`master`, very often
 *  present without `<remote>/HEAD` (a clone sets the symref, a manual
 *  `remote add` does not). */
function defaultRemoteRef(refs: RemoteRefs, remoteName: string): string | null {
  const prefix = `refs/remotes/${remoteName}/`;
  const target = refs.heads.get(`${prefix}HEAD`);
  if (target && target !== `${prefix}HEAD` && refs.names.has(target)) return target.slice('refs/remotes/'.length);
  for (const cand of ['main', 'master']) {
    if (refs.names.has(`${prefix}${cand}`)) return `${remoteName}/${cand}`;
  }
  return null;
}

/** Comparison base for a branch with no declared upstream: the remote branch
 *  of the same name (published, tracking never configured), otherwise the
 *  remote's default branch. `published` says which of the two cases applies —
 *  that is the information the UI must show, not just the counter.
 *
 *  `branch` is null (or `HEAD`) on a detached HEAD: we then fall back on the
 *  default branch. Without that path, a detached HEAD — the NORMAL state of an
 *  agent worktree during a task — had no comparison ref at all and made the
 *  ENTIRE history count as "to push". */
function resolveCompareRef(
  refs: RemoteRefs,
  remoteName: string | null,
  branch: string | null,
): { ref: string | null; published: boolean } {
  if (!remoteName) return { ref: null, published: false };
  if (branch && branch !== 'HEAD' && refs.names.has(`refs/remotes/${remoteName}/${branch}`)) {
    return { ref: `${remoteName}/${branch}`, published: true };
  }
  return { ref: defaultRemoteRef(refs, remoteName), published: false };
}

/** Every local branch, sorted by commit recency, capped at 10 — a ROOKS
 *  repository piles up `rooks/task-*` branches, alphabetical order would be
 *  unusable. The current branch is added outside the quota if the sort
 *  excludes it, otherwise it would vanish from the selector right after a
 *  checkout to an old branch.
 *
 *  A single git call for the whole batch: `%(upstream:track)` returns
 *  `[ahead N, behind M]` (or a subset, or empty with no upstream) — no need for
 *  one `rev-list` per branch. Branches WITHOUT an upstream are then handled one
 *  by one (at most 11, see the cap): they used to return `ahead: null` → "0 to
 *  push" displayed, a silent false negative on a branch NONE of whose commits
 *  are published. */
function listLocalBranches(cwd: string): Promise<string | null> {
  return git(
    ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)|%(upstream:short)|%(upstream:track)', 'refs/heads/'],
    cwd,
  );
}

async function listBranches(
  cwd: string,
  out: string | null,
  refs: RemoteRefs,
  currentBranch: string | null,
  remoteName: string | null,
): Promise<GitBranchInfo[]> {
  if (out === null || out === '') return [];
  const all = out.split('\n').filter(Boolean).map((line): GitBranchInfo => {
    const [name, declared, track] = line.split('|');
    // `[gone]`: the remote branch was deleted (merged, then pruned). Its track
    // then carries no count, which read as "0 to push, published" on a branch
    // whose commits may exist nowhere else: it is measured like a branch
    // without an upstream instead.
    const upstream = declared && track !== '[gone]' ? declared : null;
    const aheadM = /ahead (\d+)/.exec(track ?? '');
    const behindM = /behind (\d+)/.exec(track ?? '');
    return {
      name: name!,
      upstream,
      compare_ref: upstream,
      ahead: upstream ? Number(aheadM?.[1] ?? 0) : null,
      behind: upstream ? Number(behindM?.[1] ?? 0) : null,
      published: !!upstream,
    };
  });
  const top = all.slice(0, 10);
  if (currentBranch && !top.some((b) => b.name === currentBranch)) {
    const cur = all.find((b) => b.name === currentBranch);
    if (cur) top.push(cur);
  }
  // Per-branch fallback for branches without an upstream. The cost (one
  // `rev-list`) stays bounded by the cap above, and it is only paid on
  // branches that really have no tracking.
  await Promise.all(top.filter((b) => !b.upstream).map(async (b) => {
    const { ref, published } = resolveCompareRef(refs, remoteName, b.name);
    b.published = published;
    b.compare_ref = ref;
    if (!ref) return;
    const counts = await git(['rev-list', '--left-right', '--count', `${ref}...${b.name}`], cwd);
    const [behind, ahead] = (counts ?? '').split(/\s+/).map((n) => Number(n));
    if (Number.isFinite(ahead) && Number.isFinite(behind)) {
      b.ahead = ahead!;
      b.behind = behind!;
    }
  }));
  return top;
}

/** `git@github.com:o/r.git` or `https://github.com/o/r.git` → web url.
 *  Purely cosmetic: an exotic remote simply returns null. */
function toWebUrl(remote: string): string | null {
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(remote);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/(?:[^@]+@)?(.+?)(?:\.git)?$/.exec(remote);
  if (https) return `https://${https[1]}`;
  return null;
}

/** What each listed branch has left to push to each remote. A count already
 *  measured by `listBranches` against the same remote ref is reused, so a
 *  repository whose branches track their own name on a single remote pays no
 *  extra process; the other pairs cost one `rev-list` each, bounded by the
 *  branch cap times the number of remotes. */
async function listRemoteTargets(
  cwd: string,
  remotes: string[],
  urls: Map<string, RemoteUrls>,
  branches: GitBranchInfo[],
  refs: RemoteRefs,
): Promise<GitRemoteTarget[]> {
  return Promise.all(remotes.map(async (name): Promise<GitRemoteTarget> => {
    const entry = urls.get(name);
    const url = entry?.push_url ?? entry?.url ?? null;
    const targets = await Promise.all(branches.map(async (b): Promise<GitRemoteTargetBranch> => {
      const ref = `${name}/${b.name}`;
      if (!refs.names.has(`refs/remotes/${ref}`)) return { name: b.name, published: false, ahead: null };
      if (b.compare_ref === ref) return { name: b.name, published: true, ahead: b.ahead };
      const n = await git(['rev-list', '--count', `refs/remotes/${ref}..refs/heads/${b.name}`], cwd);
      const ahead = n === null ? NaN : Number(n);
      return { name: b.name, published: true, ahead: Number.isFinite(ahead) ? ahead : null };
    }));
    return { name, url, web: url ? toWebUrl(url) : null, branches: targets };
  }));
}

async function buildStatus(
  slug: string,
  cwd: string | null,
  report: CwdReport = { cwd_path: cwd, cwd_error: null, cwd_code: null },
): Promise<GitRemoteStatus> {
  const base: GitRemoteStatus = {
    slug, state: 'no-cwd', cwd, ...report, branch: null, remote_name: null, remote_count: 0,
    remote: null, remote_web: null,
    upstream: null, compare_ref: null, branch_published: false,
    ahead: null, behind: null, dirty: null, has_commits: false,
    last_commit_at: null, fetched_at: null, gh_available: await hasGh(),
    gh_account: ghAccount(), default_repo_name: cwd ? repoNameFor(cwd) : null,
    branches: [], remotes: [],
  };
  if (!cwd) return base;

  // `--is-inside-work-tree` rather than a test on `.git`: it covers linked
  // worktrees, where `.git` is a file and not a folder.
  if (await git(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') {
    return { ...base, state: 'not-a-repo' };
  }

  // Every read below is independent of the others: one parallel batch instead
  // of a dozen sequential round trips.
  const [branch, remoteList, upstream, headSha, porcelain, lastCommit, fetchHead, localBranches, remoteRefs, urls] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(['remote'], cwd),
    git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd),
    git(['rev-parse', '--verify', 'HEAD'], cwd),
    git(['status', '--porcelain'], cwd),
    git(['log', '-1', '--format=%ct'], cwd),
    git(['rev-parse', '--git-path', 'FETCH_HEAD'], cwd),
    listLocalBranches(cwd),
    readRemoteRefs(cwd),
    readRemoteUrls(cwd),
  ]);
  const remotes = (remoteList ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  const hasCommits = headSha !== null;
  // Publication remote. A hard-coded `origin` was the bug: on a repository with
  // two remotes (an archived GitHub origin, a `gitlab` actually tracked), the
  // status compared against the gitlab upstream but pushed to origin — no-op
  // push, exit 0, frozen counter, no error to show.
  const tracked = branch && branch !== 'HEAD' ? await git(['config', '--get', `branch.${branch}.remote`], cwd) : null;
  const remoteName = tracked && remotes.includes(tracked)
    ? tracked
    : remotes.includes('origin')
      ? 'origin'
      : (remotes[0] ?? null);
  const currentBranch = branch === 'HEAD' ? null : branch;

  // Remote ref used as the comparison base. A declared upstream wins;
  // otherwise we look for the same branch on origin (a published branch whose
  // tracking was never configured), then the remote's default branch. Without
  // that fallback, a feature branch with no upstream would count its WHOLE
  // history as "to push" — an alarming and wrong "589 commits".
  let compareRef: string | null = upstream;
  let branchPublished = !!upstream;
  if (!compareRef) {
    const resolved = resolveCompareRef(remoteRefs, remoteName, branch);
    compareRef = resolved.ref;
    branchPublished = resolved.published;
  }

  const remotePublishedAnything = remoteName !== null
    && [...remoteRefs.names].some((n) => n.startsWith(`refs/remotes/${remoteName}/`));

  const countAheadBehind = async (): Promise<{ ahead: number | null; behind: number | null }> => {
    if (compareRef && hasCommits) {
      // `--left-right` on a three-dot range: left = upstream, right = local.
      const counts = await git(['rev-list', '--left-right', '--count', `${compareRef}...HEAD`], cwd);
      const [b, a] = (counts ?? '').split(/\s+/).map((n) => Number(n));
      if (Number.isFinite(a) && Number.isFinite(b)) return { ahead: a!, behind: b! };
    } else if (hasCommits && !remotePublishedAnything) {
      // Nothing published at all (no remote, or an empty remote): the entire
      // history is waiting to be pushed. The creation modal uses this to
      // announce what will go out on the first `--push`. A remote that HAS
      // branches but no default one to measure against (no `HEAD` symref, no
      // `main`/`master`) gives an unknown count, not the whole history: that
      // was the "981 to push" of a detached HEAD.
      const n = await git(['rev-list', '--count', 'HEAD'], cwd);
      return { ahead: n === null ? null : Number(n), behind: null };
    }
    return { ahead: null, behind: null };
  };

  const [remote, branches, { ahead, behind }] = await Promise.all([
    remoteName ? git(['remote', 'get-url', remoteName], cwd) : Promise.resolve(null),
    listBranches(cwd, localBranches, remoteRefs, currentBranch, remoteName),
    countAheadBehind(),
  ]);
  const targets = await listRemoteTargets(cwd, remotes, urls, branches, remoteRefs);

  const state: GitRemoteState = !remoteName
    ? 'no-remote'
    : !upstream
      ? 'no-upstream'
      : (ahead ?? 0) > 0
        ? 'ahead'
        : 'synced';

  let fetchedAt: number | null = null;
  if (fetchHead) {
    // `--git-path` returns a path relative to the cwd on a standard repository:
    // resolve it against the project's cwd, not the orchestrator's.
    try { fetchedAt = statSync(isAbsolute(fetchHead) ? fetchHead : join(cwd, fetchHead)).mtimeMs; }
    catch { fetchedAt = null; }
  }

  return {
    ...base,
    state,
    branch: currentBranch,
    remote_name: remoteName,
    remote_count: remotes.length,
    remote: remote ? redactUrlCredentials(remote) : null,
    remote_web: remote ? toWebUrl(remote) : null,
    upstream,
    compare_ref: compareRef,
    branch_published: branchPublished,
    ahead,
    behind,
    dirty: porcelain === null ? null : porcelain === '' ? 0 : porcelain.split('\n').length,
    has_commits: hasCommits,
    last_commit_at: lastCommit ? Number(lastCommit) * 1000 : null,
    fetched_at: fetchedAt,
    branches,
    remotes: targets,
  };
}

/** How long a status is served from memory. The Git widget polls it and
 *  several windows (or tabs) poll it together: without this, each of them
 *  relaunched the whole batch of git commands for the same repository. Short
 *  enough that a commit made in a terminal shows up at the next poll or so. */
const STATUS_TTL_MS = 3000;
/** In-flight statuses are shared too (`expires` = Infinity until settled):
 *  two requests arriving together wait for the same git batch. */
const statusCache = new Map<string, { expires: number; value: Promise<GitRemoteStatus> }>();

/** A project's root repository and each nested one are cached apart. A NUL
 *  cannot occur in a slug nor in a validated repo path. */
function cacheKey(slug: string, repo?: string): string {
  return repo ? `${slug}\0${repo}` : slug;
}

/** The folder a gesture works in: the project's, or one of its nested
 *  repositories (`repo`, relative to it). Throws when there is none. */
function workCwd(slug: string, repo?: string): string {
  const cwd = resolveProjectCwd(slug).cwd;
  if (!cwd) throw new Error(`project "${slug}" has no usable cwd`);
  return resolveRepoCwd(cwd, repo);
}

function remember(key: string, value: Promise<GitRemoteStatus>): Promise<GitRemoteStatus> {
  const now = Date.now();
  // The key comes from the URL: expired entries are dropped on every write so
  // unknown slugs cannot pile up.
  for (const [k, e] of statusCache) if (e.expires <= now) statusCache.delete(k);
  const entry = { expires: Number.POSITIVE_INFINITY, value };
  statusCache.set(key, entry);
  value.then(
    () => { entry.expires = Date.now() + STATUS_TTL_MS; },
    () => { if (statusCache.get(key) === entry) statusCache.delete(key); },
  );
  return value;
}

export function getStatus(slug: string, repo?: string): Promise<GitRemoteStatus> {
  const key = cacheKey(slug, repo);
  const hit = statusCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  // `resolveProjectCwd` may throw (unknown project), `resolveRepoCwd` too (a
  // repo outside the project): turned into a rejection, answered with a 400.
  return remember(key, (async () => {
    const resolved = resolveProjectCwd(slug);
    if (!repo || !resolved.cwd) return buildStatus(slug, resolved.cwd, reportOf(resolved));
    const cwd = resolveRepoCwd(resolved.cwd, repo);
    return buildStatus(slug, cwd, usableReport(cwd));
  })());
}

/** A push, fetch or remote creation changes the status: the next poll must see
 *  the fresh one, not the cached one from before the action. */
async function refreshStatus(slug: string, cwd: string, repo?: string): Promise<GitRemoteStatus> {
  return remember(cacheKey(slug, repo), buildStatus(slug, cwd, usableReport(cwd)));
}

/** The same status, for an arbitrary folder outside the project registry. Used
 *  by the tests: the cases that break here (detached HEAD, branch with no
 *  upstream, missing `<remote>/HEAD`) can be built in three git commands in a
 *  throwaway folder, but are invisible on the repositories at hand. */
export function statusForCwd(cwd: string, slug = basename(cwd)): Promise<GitRemoteStatus> {
  const check = checkCwd(cwd);
  return check.ok
    ? buildStatus(slug, cwd)
    : buildStatus(slug, null, { cwd_path: cwd, cwd_error: check.error, cwd_code: check.code });
}

/** Creates the remote repository on GitHub and pushes the current branch.
 *
 *  `gh repo create --source --remote origin --push` performs all three gestures
 *  at once: creation on the GitHub side, remote added, push with upstream. We
 *  do not split it up, otherwise a failure halfway through leaves an empty
 *  remote repository and a half-configured remote.
 *
 *  Private by default: accidentally publishing a personal project is
 *  irreversible (indexing, forks), while the opposite costs one click. */
export async function createRemote(
  slug: string,
  opts: { private?: boolean; name?: string; description?: string } = {},
  repo?: string,
): Promise<GitRemoteStatus> {
  const cwd = workCwd(slug, repo);
  if (!await hasGh()) throw new Error('`gh` CLI not found — install GitHub CLI then run `gh auth login`');

  const before = await buildStatus(slug, cwd);
  if (before.state === 'not-a-repo') throw new Error('not a git repository — run `git init` first');
  if (before.remote_name) return before; // idempotent: a remote already exists, nothing to create
  if (!before.has_commits) throw new Error('repository with no commit — make a first commit before publishing');

  const name = opts.name?.trim() ? repoNameFor(opts.name.trim()) : repoNameFor(cwd);
  const description = opts.description?.trim();
  const r = await run('gh', [
    'repo', 'create', name,
    '--source', cwd,
    '--remote', 'origin',
    opts.private === false ? '--public' : '--private',
    ...(description ? ['--description', description] : []),
    '--push',
  ], cwd, NET_TIMEOUT_MS);

  if (!r.ok) throw new Error(`gh repo create failed: ${failure(r)}`);
  return refreshStatus(slug, cwd, repo);
}

/** Pushes a local branch to ITS tracking remote (see `remote_name`), or to
 *  `remote` when one is named. Default: the current branch to its tracking
 *  remote — historical behaviour unchanged.
 *
 *  `branch` can name any local branch, NOT necessarily the current one: never
 *  a `git checkout` here, since a listed branch may be in use by an agent
 *  worktree in the middle of its work (`~/.rooks/worktrees/`). We push the
 *  local ref directly (`refs/heads/<branch>`), the main repository's HEAD does
 *  not move.
 *
 *  Sets the upstream if the branch has none — without it a bare `git push`
 *  fails on a branch that was never published. A push to another remote than
 *  that one never touches the upstream: it publishes a copy, the branch keeps
 *  tracking where it did. */
export async function push(slug: string, branch?: string, repo?: string, remote?: string): Promise<GitRemoteStatus> {
  const cwd = workCwd(slug, repo);

  const before = await buildStatus(slug, cwd);
  const targetBranch = branch ?? before.branch;
  if (!targetBranch) throw new Error('detached HEAD — check out a branch before pushing');
  // The branch must come from the list enumerated by `buildStatus`: it ends up
  // in a `host.exec('git', [...])`, so a name starting with `-` would otherwise
  // become a flag. Membership in the list counts as validation.
  if (targetBranch !== before.branch && !before.branches.some((b) => b.name === targetBranch)) {
    throw new Error(`branch "${targetBranch}" not found`);
  }
  if (!before.has_commits) throw new Error('repository with no commit — nothing to push');

  const [remoteList, tracked, mergeRef] = await Promise.all([
    git(['remote'], cwd),
    git(['config', '--get', `branch.${targetBranch}.remote`], cwd),
    git(['config', '--get', `branch.${targetBranch}.merge`], cwd),
  ]);
  const remotes = (remoteList ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  const remoteName = tracked && remotes.includes(tracked)
    ? tracked
    : remotes.includes('origin')
      ? 'origin'
      : (remotes[0] ?? null);
  if (!remoteName) throw new Error('no remote — create it first');
  // The name reaches `git push` as an argument: only a declared remote passes.
  if (remote !== undefined && !remotes.includes(remote)) throw new Error(`remote "${remote}" not found`);
  if (remote !== undefined && remote !== remoteName) return pushElsewhere(slug, cwd, before, targetBranch, remote, repo);

  const branchInfo = before.branches.find((b) => b.name === targetBranch) ?? null;
  const upstream = branchInfo?.upstream ?? null;

  // Explicit refspec when an upstream exists: the local ref alone would push to
  // a remote branch of the same name, not necessarily the tracked one (locally
  // renamed branch, upstream under another name).
  const args = upstream
    ? ['push', remoteName, mergeRef ? `refs/heads/${targetBranch}:${mergeRef}` : `refs/heads/${targetBranch}`]
    : ['push', '-u', remoteName, targetBranch];
  const r = await run('git', args, cwd, NET_TIMEOUT_MS);
  if (!r.ok) throw new Error(`git push failed: ${failure(r)}`);

  const after = await refreshStatus(slug, cwd, repo);
  const beforeAhead = branchInfo?.ahead ?? 0;
  const afterInfo = after.branches.find((b) => b.name === targetBranch) ?? null;
  const afterAhead = afterInfo?.ahead ?? 0;
  // Net against the original failure mode: a push that returned 0 without
  // pushing anything left the counter frozen and the user with no explanation.
  if (afterAhead > 0 && afterAhead >= beforeAhead) {
    throw new Error(
      `git push to \`${remoteName}\` returned 0 but ${afterAhead} commit(s) are still pending on \`${targetBranch}\` — check which remote the branch tracks`,
    );
  }
  return after;
}

/** `git push <remote> <branch>:<branch>`, without `-u`: the branch's upstream
 *  stays the one configured. */
async function pushElsewhere(
  slug: string,
  cwd: string,
  before: GitRemoteStatus,
  branch: string,
  remote: string,
  repo?: string,
): Promise<GitRemoteStatus> {
  const pending = (s: GitRemoteStatus) => s.remotes.find((r) => r.name === remote)?.branches.find((b) => b.name === branch) ?? null;
  const r = await run('git', ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`], cwd, NET_TIMEOUT_MS);
  if (!r.ok) throw new Error(`git push failed: ${failure(r)}`);
  const after = await refreshStatus(slug, cwd, repo);
  const beforeAhead = pending(before)?.ahead ?? 0;
  const afterAhead = pending(after)?.ahead ?? 0;
  if (afterAhead > 0 && afterAhead >= beforeAhead) {
    throw new Error(`git push to \`${remote}\` returned 0 but ${afterAhead} commit(s) are still pending on \`${branch}\``);
  }
  return after;
}

/** Explicit `git fetch`: the only way to refresh `behind`, which the status
 *  never recomputes on its own (see the module header). */
export async function fetch(slug: string, repo?: string): Promise<GitRemoteStatus> {
  const cwd = workCwd(slug, repo);
  const before = await buildStatus(slug, cwd);
  if (!before.remote_name) throw new Error('no remote to query');

  const r = await run('git', ['fetch', '--prune', before.remote_name], cwd, NET_TIMEOUT_MS);
  if (!r.ok) throw new Error(`git fetch failed: ${failure(r)}`);
  return refreshStatus(slug, cwd, repo);
}

export type GitRemoteEntry = {
  name: string;
  /** fetch url as configured, credentials masked */
  url: string | null;
  /** push url when one is set apart from the fetch url, credentials masked */
  push_url: string | null;
};

/** Outcome of reaching a remote right after saving it. Saving never contacts
 *  the network; without this, a missing SSH key or an unknown host would only
 *  surface at the first push. */
export type RemoteCheck = { ok: true } | { ok: false; error: string };

export type RemoteChange = { git: GitRemoteStatus; remotes: GitRemoteEntry[]; check: RemoteCheck | null };

/** Shorter than a push: it only lists refs, and a prompt nobody can answer
 *  (ssh asking for a passphrase) must not hold the dialog for two minutes. */
const CHECK_TIMEOUT_MS = 30_000;

async function repoCwd(slug: string, repo?: string): Promise<string> {
  const cwd = workCwd(slug, repo);
  if (await git(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') {
    throw new Error('not a git repository — run `git init` first');
  }
  return cwd;
}

type RemoteUrls = { url: string | null; push_url: string | null };

async function readRemoteUrls(cwd: string): Promise<Map<string, RemoteUrls>> {
  // One read for every url; `remote get-url` per remote would cost a process each.
  const config = await git(['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], cwd);
  const urls = new Map<string, RemoteUrls>();
  for (const line of (config ?? '').split('\n')) {
    // The name may hold dots (`remote.my.fork.url`): the suffix anchors it.
    const m = /^remote\.(.+)\.(url|pushurl) (.*)$/.exec(line);
    if (!m) continue;
    const entry = urls.get(m[1]!) ?? { url: null, push_url: null };
    // A remote may declare several urls; the first is the one git fetches from.
    if (m[2] === 'url') entry.url ??= redactUrlCredentials(m[3]!);
    else entry.push_url ??= redactUrlCredentials(m[3]!);
    urls.set(m[1]!, entry);
  }
  return urls;
}

async function readRemotes(cwd: string): Promise<GitRemoteEntry[]> {
  const [names, urls] = await Promise.all([git(['remote'], cwd), readRemoteUrls(cwd)]);
  return (names ?? '').split('\n').map((n) => n.trim()).filter(Boolean)
    .map((name) => ({ name, url: urls.get(name)?.url ?? null, push_url: urls.get(name)?.push_url ?? null }));
}

/** Every remote of the project's repository, not only the publication one. */
export async function listRemotes(slug: string, repo?: string): Promise<GitRemoteEntry[]> {
  return readRemotes(await repoCwd(slug, repo));
}

function assertRemoteUrl(url: string): string {
  const checked = checkRemoteUrl(url);
  if (!checked.ok) throw new Error(REMOTE_URL_MESSAGES[checked.reason]);
  return checked.url;
}

async function assertRemoteExists(cwd: string, name: string): Promise<void> {
  const names = (await git(['remote'], cwd) ?? '').split('\n').map((n) => n.trim());
  if (!names.includes(name)) throw new Error(`remote "${name}" not found`);
}

async function checkReach(cwd: string, name: string): Promise<RemoteCheck> {
  // No terminal behind the daemon: git must fail rather than wait for a
  // username nobody will type.
  const r = await run('git', ['ls-remote', '--heads', '--', name], cwd, CHECK_TIMEOUT_MS, {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  });
  return r.ok ? { ok: true } : { ok: false, error: failure(r) };
}

async function afterChange(slug: string, cwd: string, name: string | null, repo?: string): Promise<RemoteChange> {
  const check = name ? await checkReach(cwd, name) : null;
  const [status, remotes] = await Promise.all([refreshStatus(slug, cwd, repo), readRemotes(cwd)]);
  return { git: status, remotes, check };
}

/** `git remote add`. The remote is kept even when it cannot be reached:
 *  `check` says why, in git's words, and the url can then be corrected. */
export async function addRemote(
  slug: string,
  opts: { name: string; url: string; check?: boolean },
  repo?: string,
): Promise<RemoteChange> {
  const url = assertRemoteUrl(opts.url);
  const cwd = await repoCwd(slug, repo);
  // `--`: neither the name nor the url can ever be read as an option.
  const r = await run('git', ['remote', 'add', '--', opts.name, url], cwd);
  if (!r.ok) throw new Error(`git remote add failed: ${failure(r)}`);
  return afterChange(slug, cwd, opts.check === false ? null : opts.name, repo);
}

/** `git remote set-url` on the fetch url; a separate push url is left alone. */
export async function setRemoteUrl(
  slug: string,
  opts: { name: string; url: string; check?: boolean },
  repo?: string,
): Promise<RemoteChange> {
  const url = assertRemoteUrl(opts.url);
  const cwd = await repoCwd(slug, repo);
  await assertRemoteExists(cwd, opts.name);
  const r = await run('git', ['remote', 'set-url', '--', opts.name, url], cwd);
  if (!r.ok) throw new Error(`git remote set-url failed: ${failure(r)}`);
  return afterChange(slug, cwd, opts.check === false ? null : opts.name, repo);
}

/** `git remote remove`: git also drops the remote-tracking branches and the
 *  tracking configuration of the branches that followed it. */
export async function removeRemote(slug: string, name: string, repo?: string): Promise<RemoteChange> {
  const cwd = await repoCwd(slug, repo);
  await assertRemoteExists(cwd, name);
  const r = await run('git', ['remote', 'remove', '--', name], cwd);
  if (!r.ok) throw new Error(`git remote remove failed: ${failure(r)}`);
  return afterChange(slug, cwd, null, repo);
}
