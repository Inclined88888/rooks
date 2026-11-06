/** Types + helpers shared by the project grid and its cards. */

export type Project = {
  slug: string;
  name?: string | null;
  color?: string | null;
  icon?: string | null;
  workspace?: string | null;
  cwd?: string | null;
  speech?: string | null;
  status?: string | null;
  last_activity?: number | null;
};

export type Agent = {
  name: string;
  main?: boolean;
  project?: string | null;
  role?: string | null;
  /** The daemon's reading: the `orchestrator` flag OR the orchestrator role. */
  orchestrator?: boolean;
  ephemeral?: boolean;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  model?: string | null;
  /** Mascot look and picked head (`config.look`, `config.avatar`). */
  look?: unknown;
  avatar?: unknown;
};

/** Why the daemon cannot use a project's registered cwd (TIM-0083). */
export type CwdError = 'missing' | 'denied' | 'not-a-directory';

/** Next to `cwd` (the usable one): the registered path and why it fails. */
export type CwdReport = {
  cwd_path: string | null;
  cwd_error: CwdError | null;
  /** raw errno (`EPERM`, `ENOENT`…) or `NOT_A_DIRECTORY` */
  cwd_code: string | null;
};

export type WatcherState = 'running' | 'stopped' | 'not-indexed' | 'no-cwd';

export type Watcher = CwdReport & {
  slug: string;
  state: WatcherState;
  cwd: string | null;
  pid: number | null;
  indexed_at: number | null;
  index_age_ms: number | null;
  index_bytes: number | null;
};

export type GitRemoteState =
  | 'no-cwd'
  | 'not-a-repo'
  | 'no-remote'
  | 'no-upstream'
  | 'ahead'
  | 'synced';

export type GitRemote = CwdReport & {
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
  ahead: number | null;
  behind: number | null;
  dirty: number | null;
  has_commits: boolean;
  last_commit_at: number | null;
  fetched_at: number | null;
  gh_available: boolean;
  gh_account: string | null;
  default_repo_name: string | null;
};

export type DockerState =
  | 'no-cwd'
  | 'no-docker'
  | 'none'
  | 'running'
  | 'partial'
  | 'stopped';

export type DockerContainer = {
  id: string;
  name: string;
  service: string | null;
  state: string;
  health: string | null;
  started_at: number | null;
  url: string | null;
  ports: string[];
};

export type Docker = CwdReport & {
  slug: string;
  state: DockerState;
  cwd: string | null;
  project: string | null;
  containers: DockerContainer[];
  url: string | null;
};

export type BrowserStatus = 'running' | 'stopped';

/** Browser session of a project (Chromium container with a persistent profile).
 *  The row SURVIVES the stop (it carries the CDP port given to the project), so
 *  `status` is the only "up or not" signal. */
export type Browser = {
  project: string;
  container_name: string;
  cdp_port: number;
  status: BrowserStatus;
  started_at: number | null;
  stopped_at: number | null;
  cdp_url: string;
  url: string | null;
};

/** Beyond this, the index is deemed doubtful even if a watcher runs. */
export const GREPAI_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Deliberately approximate compact duration: we want an order of magnitude. */
export function humanAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} j`;
}
