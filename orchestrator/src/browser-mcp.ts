/**
 * Hooking `chrome-devtools-mcp` onto the project's browser.
 *
 * Extracted from `browser-sessions.ts` (step 1.2): the three backend dialects
 * only needed these symbols, but importing them dragged along
 * all the Docker/Traefik driving of the containers — and closed the cycle
 * `agent ↔ backends ↔ browser-sessions`. Here, we only depend on the database and
 * the project slug.
 *
 * Verbatim move, with one exception documented below: the default
 * resolution now goes through `dbApi` rather than through the enriched
 * `getBrowserSession` of `browser-sessions.ts` (which would call Docker).
 */
import { dbApi, type BrowserSessionStatus } from './db.js';
import { fileURLToPath } from 'node:url';
import { apiBaseUrl } from './api-url.js';
import { projectFromCwd } from './task-project.js';
import { settingStr } from './settings.js';
import { containerProjectMount } from './browser-container-paths.js';
import { UPLOAD_RELAY_SPEC_ENV, type UploadRelaySpec } from './browser-upload-relay.js';

/** Shared persistent browser for agents without a resolvable project. */
export const GENERAL_BROWSER_SLUG = '__rooks_general__';

const SLUG_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * Status checker set by `browser-sessions.ts` at load.
 *
 * `getBrowserSession` realigned the database on the living Docker containers
 * (`verifyBrowserStatuses`, throttled to 5 s) BEFORE reading the row. Without it,
 * a dead container whose death the database ignores would hook the MCP onto a
 * closed port — a perfectly silent failure on the agent side. So the call is kept,
 * but by injection: this module must import neither Docker nor Traefik.
 * Missing (browser module not loaded), the database is read as is.
 */
let verifyStatuses: (() => void) | null = null;

export function setBrowserStatusVerifier(fn: () => void): void {
  verifyStatuses = fn;
}

/** Bumps the activity signal — same contract as `touchBrowserSessionActivity`
 *  of `browser-sessions.ts`, which stays its public facade. */
function touchBrowserSessionActivity(slug: string, at: number = Date.now()): void {
  dbApi.touchBrowserSessionActivity(slug, at);
}

/**
 * Resolves and bumps in one gesture — the side-effecting counterpart of
 * `chromeDevtoolsMcpEntry`, which stays PURE and must not touch it (its
 * tests count the calls to `lookup`, a side effect would break the
 * contract). Called by the dialects right after getting a non-null MCP
 * entry: it is the only moment we know an agent has just hooked this
 * browser for its mission.
 */
export function noteBrowserSessionSpawned(
  ref: { project?: string | null; cwd?: string | null; browser_profile_id?: string | null } | null | undefined,
): void {
  if (ref?.browser_profile_id !== undefined) return;
  const slug = (ref?.project || projectFromCwd(ref?.cwd)) ?? GENERAL_BROWSER_SLUG;
  if (!slug || !isValidSlug(slug)) return;
  touchBrowserSessionActivity(slug);
}

/* ────────────────────────────────────────────────────────────────────────────
   Hooking `chrome-devtools-mcp` onto the project's browser.
   ──────────────────────────────────────────────────────────────────────────── */

/** Key of the server in the MCP config. Deliberately DISTINCT from `chrome-devtools`:
 *  that name stays the user's (their own Chrome, their own server), Rooks
 *  imposes nothing. If the built-in browser breaks after an update,
 *  the user therefore keeps a working `chrome-devtools` alongside. The
 *  tools are the same (`navigate_page`, `take_snapshot`…), under the prefix
 *  `mcp__rooks-browser__*` (codex: `mcp__rooks-browser__*`). */
export const CHROME_DEVTOOLS_MCP_KEY = 'rooks-browser';

/** npm package of the server. Overridable to pin a version the day
 *  `@latest` breaks — same reason as `ROOKS_BROWSER_IMAGE`. */
function chromeDevtoolsMcpPackage(): string {
  return settingStr('ROOKS_CHROME_DEVTOOLS_MCP');
}

export type McpStdioEntry = { command: string; args: string[]; env?: Record<string, string> };

/** What the resolution needs from a session: the rest of the row does not
 *  concern it. Typed as tightly as possible so that the tests can inject a
 *  fake without rebuilding a complete `BrowserSessionRow`. */
export type CdpTarget = {
  status: BrowserSessionStatus;
  cdp_url: string;
  /** Project folder mounted in the container (host path), if any. */
  project_path?: string | null;
};

/** Default resolution: the row in the database, reduced to what the hooking
 *  looks at. `cdp_url` is derived from the published port, exactly as
 *  `enrich()` does in `browser-sessions.ts`. */
function defaultLookup(slug: string): CdpTarget | null {
  verifyStatuses?.();
  const row = dbApi.getBrowserSession(slug);
  if (!row) return null;
  // The project row, not `readMeta`: `projects.ts` would drag the backend
  // registry in, and this module is imported by the backends.
  const project_path = slug === GENERAL_BROWSER_SLUG ? null : dbApi.getProjectRow(slug)?.cwd ?? null;
  return { status: row.status, cdp_url: `http://127.0.0.1:${row.cdp_port}`, project_path };
}

/**
 * `chrome-devtools` MCP entry targeting the project's browser, or `null`.
 *
 * `null` means "inject nothing" — and so let the CLI load its
 * own `chrome-devtools` declaration, which starts a local Chrome. It is the
 * DELIBERATE fallback (option b of the brief): starting the container on the fly here
 * would cost up to 5 minutes of `docker pull` on the critical path of the spawn
 * of EVERY agent, for a capability most missions never
 * use — and would resurrect at the next turn a browser the user has just
 * stopped by hand. Starting stays explicit (`/browser` UI, API
 * `startBrowserSession`).
 *
 * Corollary to know: the MCP config is frozen at the CLI's spawn. A
 * browser started DURING a mission is only taken into account at its next
 * spawn, not at the next turn.
 *
 * PURE function once `lookup` is injected: it is the only logic of the
 * hooking that can be wrong silently (targeting a dead port gives a
 * silent MCP server, not an error), hence testable without docker or a database.
 */
export function chromeDevtoolsMcpEntry(
  ref: { project?: string | null; cwd?: string | null; browser_profile_id?: string | null } | null | undefined,
  lookup: (slug: string) => CdpTarget | null = defaultLookup,
  platform: NodeJS.Platform = process.platform,
): McpStdioEntry | null {
  // Even a disabled profile overrides any user-scoped Chrome MCP. The daemon
  // derives the authorized profile from the mission token, never this config.
  if (ref?.browser_profile_id !== undefined) {
    return { command: process.execPath, args: [fileURLToPath(new URL('../bin/browser-mcp.mjs', import.meta.url))],
      env: { ROOKS_ORCH_URL: apiBaseUrl(), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } };
  }
  // Same precedence as everywhere else (see `taskProjectSlug`): the agent's
  // declared project wins over the cwd. The order matters for tasks, whose
  // cwd is a worktree `~/.rooks/worktrees/<id>` from which no slug can be inferred.
  const slug = (ref?.project || projectFromCwd(ref?.cwd)) ?? GENERAL_BROWSER_SLUG;
  if (!slug || !isValidSlug(slug)) return null;

  const session = lookup(slug);
  // `stopped` still carries its assigned port: without this test the MCP would be
  // hooked onto a closed port, a perfectly silent failure on the agent side.
  if (!session || session.status !== 'running' || !session.cdp_url) return null;

  const server = { command: 'npx', args: ['-y', chromeDevtoolsMcpPackage(), '--browserUrl', session.cdp_url] };
  // Windows: the container sees the project under a translated path, so
  // `upload_file` paths go through the relay that translates them (TIM-0120).
  // Linux and macOS mount it at the same path: nothing to translate.
  const mount = platform === 'win32' ? containerProjectMount(session.project_path, platform) : null;
  if (!mount) return server;
  const spec: UploadRelaySpec = { ...server, mount, platform };
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./browser-upload-relay-runner.js', import.meta.url))],
    env: {
      [UPLOAD_RELAY_SPEC_ENV]: JSON.stringify(spec),
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  };
}
