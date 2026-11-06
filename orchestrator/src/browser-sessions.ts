/**
 * Embedded browser: lifecycle of Chromium containers, one per project.
 *
 * ## Why
 *
 * Many useful agent gestures (logging into a client back-office, reading a
 * page behind a login, checking a UI) need a browser that is ALREADY
 * AUTHENTICATED. A single shared browser would mix every client's sessions in
 * the same profile: one project's cookie visible from another project's mission, a logout
 * on one side breaking the other. Hence one container — and above all one
 * PROFILE — per project.
 *
 * ## The three mounting invariants
 *
 * 1. **The profile survives the container.** `~/.timon/browser-profiles/<slug>`
 *    is mounted on `/config` and is NEVER deleted by this module: `stop`
 *    destroys the container, not the session. Without that, every restart
 *    would re-ask every password, which empties the feature of its point.
 *
 * 2. **CDP on loopback, never on 0.0.0.0.** Chromium's debug port gives TOTAL
 *    control of the browser — hence of every authenticated session it carries —
 *    to whoever reaches it, with no authentication at all. Published on
 *    `0.0.0.0`, it would be open to the whole local network (and Tailscale).
 *    It is published on the host because the consumer, the orchestrator, runs
 *    in host mode and cannot see the docker network.
 *
 *    This port does NOT come straight from Chromium: since Chrome ~111,
 *    `--remote-debugging-address` is ignored and the debugger listens ONLY on
 *    `127.0.0.1` INSIDE the container — so unreachable through a port mapping
 *    (verified on the image, Chrome 151: `ss -ltn` shows `127.0.0.1:9222`, the
 *    flag is passed but has no effect). A `socat` relay therefore runs in the
 *    SAME network stack as the browser (`--network container:<browser>`) and
 *    re-publishes the debugger on the publishable port. The mapping stays on
 *    `127.0.0.1` on the host: the relay changes nothing about exposure, it just
 *    makes the port reachable.
 *
 * 3. **noVNC is NOT published on the host.** Its consumer is Traefik, which
 *    runs in a container on `traefik_network`: it reaches the browser over the
 *    docker network. Publishing this port as well would only add attack
 *    surface. Routing is set as LABELS at creation — Traefik's Docker provider
 *    discovers them on its own, no static config to touch.
 *    (Multi-machine V10b published it on the host loopback for a daemon-side
 *    relay to remote machines; withdrawn on 25/10/2026 with that relay, which
 *    no screen used — the built-in browser shown is the native one.)
 *
 * ## Automatic close on idle (and why it is no longer taboo)
 *
 * This module long refused any automatic close: a timeout would kill a work
 * session in progress (half-filled form, 2FA already validated) with no
 * warning. That was true as long as stopping wiped the open tabs — Chromium,
 * restarted after a `docker stop`, shows "Restore pages?" and opens nothing
 * until someone clicks (verified on the `nimbus` profile: the session is
 * flushed to disk, but `exit_type` stays `"Crashed"` and nothing restores
 * itself).
 *
 * In 2026-08, three browsers ran 14 to 38 h with nobody in front of them —
 * discovered by the fan noise, not by a system signal. Automatic close fixes
 * that, but it was only acceptable once the original objection was defused:
 * `restoreOpenTabs` reopens the tabs on restart (natural path via `Preferences`
 * rewritten at stop, safety net via the URLs captured while CDP still answered)
 * — stopping becomes a mere sleep, not a loss of context.
 *
 * Configurable threshold (`TIMON_BROWSER_IDLE_MINUTES`, default 30 min, ≤0
 * disables) against a CROSSED activity signal — see `closeIdleBrowserSessions`:
 * a bad signal would kill a live session, exactly what the old doctrine feared,
 * so better to spare wrongly than to close wrongly.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dbApi, type BrowserSessionRow, type BrowserSessionStatus, type DbViewer } from './db.js';
import { getHost } from './host/index.js';
import { browserProfileDir } from './paths.js';
import { readMeta } from './projects.js';
import { projectFromCwd } from './task-project.js';
import { containerProjectMount } from './browser-container-paths.js';
import { settingInt, settingStr } from './settings.js';

/** Browser image. `linuxserver/chromium` serves its remote desktop via
 *  **Selkies** (WebRTC streaming — the image left KasmVNC, and the original
 *  noVNC setup before that; only the `novnc_*` names in the schema remain) and
 *  accepts Chromium flags through `CHROME_CLI`. Overridable: the day the image
 *  changes name or web port, we do not want to redeploy the orchestrator just
 *  to discover it. */
function image(): string { return settingStr('TIMON_BROWSER_IMAGE'); }

/** Container web port, the one Traefik routes. 3000 is the Selkies client port
 *  in current linuxserver images (the old noVNC setup listened on 6080; the
 *  name stayed in the schema, not the number). Overridable for the same reason
 *  as the image — the two come as a pair. */
function webPort(): number { return settingInt('TIMON_BROWSER_WEB_PORT'); }

/** Port on which Chromium opens its debugger, INSIDE the container.
 *  It only listens on the container loopback (see header), so we never publish
 *  it directly. */
const CDP_CONTAINER_PORT = 9222;

/** Port of the socat relay, in the same network stack as the browser. THIS is
 *  the one published on the host loopback. */
const CDP_PROXY_PORT = 9223;

/** Relay image: a 4 MB socat, nothing else. */
function proxyImage(): string { return settingStr('TIMON_BROWSER_PROXY_IMAGE'); }

/** Range of CDP ports published on loopback. 100 concurrent projects is far
 *  beyond real need; the range is mainly there to stay recognizable in an
 *  `ss -ltnp` ("93xx = a TIMON browser"). */
export const CDP_PORT_RANGE: readonly [number, number] = [9300, 9399];

/** Host reachable for Traefik FROM the docker network: its container name.
 *  Overridable if the stack renames it. */
function traefikHost(): string { return settingStr('TIMON_TRAEFIK_HOST'); }

/** Traefik entry ports relayed onto the browser loopback. */
const WEB_PORTS = [80, 443] as const;

/** Docker network shared with Traefik. External, declared in docker-compose.yml. */
function network(): string { return settingStr('TIMON_BROWSER_NETWORK'); }

/** Hosts on which the Selkies stream is routable, comma-separated. These are
 *  the existing app routers (`timon-secure`, `timon-tailscale`): the browser
 *  grafts itself under `/browser/<slug>` of the SAME hosts, so it is reachable
 *  from the phone via Tailscale without a new certificate. */
function hosts(): string[] {
  return settingStr('TIMON_BROWSER_HOSTS')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

/** A `docker run` pulls the image on first start: several minutes. */
const RUN_TIMEOUT_MS = 300_000;
/** `docker stop` leaves 10 s for SIGTERM before killing; `rm` is immediate. */
const STOP_TIMEOUT_MS = 60_000;
const PS_TIMEOUT_MS = 5_000;

/** Minutes of inactivity before automatic close. Read on EVERY call (not frozen
 *  as a constant): The user can tighten or cut the threshold without restarting the
 *  orchestrator — see `permissions.ts` for the same choice on another timeout.
 *  ≤0 disables automatic close entirely. */
function idleMinutesSetting(): number {
  return settingInt('TIMON_BROWSER_IDLE_MINUTES');
}

/** Time given to CDP to answer a `/json/*` — both navigation and restore must
 *  fail fast rather than hang the periodic sweep on a browser that just
 *  crashed. */
const CDP_HTTP_TIMEOUT_MS = 4_000;

/** Poll cadence and wait budget for a FRESHLY started browser to answer on its
 *  CDP, before attempting tab restore. A `docker run` of an already-pulled image
 *  answers in a handful of seconds; past that we give up rather than make the
 *  `startBrowserSession` caller wait forever. */
const CDP_READY_POLL_MS = 500;
const CDP_READY_TIMEOUT_MS = 15_000;

/** Slack left to Chromium after its CDP answers: the process is up, but its
 *  native restore (`session.restore_on_startup`) may still be creating tabs —
 *  comparing too early would duplicate everything. */
const RESTORE_SETTLE_MS = 2_000;

/** Same grammar as `validSlug` in projects.ts. Checked BEFORE any container
 *  name, path or label is built: a slug is an API input, and it ends up here in
 *  docker arguments. */

/* Moved verbatim into `browser-mcp.ts` (step 1.2): backend dialects only need
   these, and importing them from here pulled in the whole Docker/Traefik
   steering — that was the third edge of the
   `agent ↔ backends ↔ browser-sessions` cycle. Re-exported: no other import moves. */
import {
  CHROME_DEVTOOLS_MCP_KEY, GENERAL_BROWSER_SLUG, chromeDevtoolsMcpEntry, isValidSlug,
  noteBrowserSessionSpawned, setBrowserStatusVerifier,
  type CdpTarget, type McpStdioEntry,
} from './browser-mcp.js';
export {
  CHROME_DEVTOOLS_MCP_KEY, GENERAL_BROWSER_SLUG, chromeDevtoolsMcpEntry, isValidSlug,
  noteBrowserSessionSpawned, type CdpTarget, type McpStdioEntry,
};

export type BrowserSession = BrowserSessionRow & {
  /** CDP endpoint as the orchestrator (host mode) must target it. */
  cdp_url: string;
  /** Remote-desktop URL, via Traefik. Null if no host is configured. */
  url: string | null;
};


function assertSlug(slug: string): void {
  if (!isValidSlug(slug)) throw new Error(`invalid project slug: "${slug}"`);
}

/** Container name. Deterministic: it is also the join key with `docker ps` at
 *  reconciliation. */
export function containerName(slug: string): string {
  return `timon-browser-${slug}`;
}

/** Traefik router name derived from the slug. Traefik labels are split on the
 *  DOT (`traefik.http.routers.<name>.rule`): a slug that contains one —
 *  `SLUG_RE` allows them — would produce an unmanageable label key, silently
 *  ignored by Traefik. So we keep only `[a-z0-9-]`. */
export function routerName(slug: string): string {
  return `timon-browser-${slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
}

/** HTTP prefix under which the remote desktop is served. */
export function browserPath(slug: string): string {
  return `/browser/${slug}`;
}

/** Name of the project's CDP relay. A separate container rather than a service
 *  added to a homemade image: no image to build or maintain, and a dead relay
 *  restarts on its own (see `reconcileBrowserSessions`) without touching the
 *  browser or its session. */
export function proxyName(slug: string): string {
  return `timon-cdp-${slug}`;
}

/** Name of the web relay (loopback → Traefik). See `webProxyArgs`. */
export function webProxyName(slug: string): string {
  return `timon-web-${slug}`;
}

export type Run = { ok: boolean; out: string; err: string };

function run(args: string[], timeout: number): Run {
  try {
    const host = getHost();
    const r = host.containers
      ? host.containers.cli(args, timeout)
      : host.exec('docker', args, { timeout });
    return {
      ok: r.code === 0,
      out: r.stdout.trim(),
      err: r.stderr.trim(),
    };
  } catch (err) {
    return { ok: false, out: '', err: (err as Error).message };
  }
}

/**
 * Allocate a port in `range` avoiding `used`, preferring `preferred` if it is
 * free.
 *
 * PURE function, and that is deliberate: this is the only logic in the module
 * that can fail silently (a port reassigned to two projects only shows up at
 * the second `docker run`, as an unreadable bind-refused message). It is
 * therefore testable without docker or a database.
 */
export function allocatePort(
  range: readonly [number, number],
  used: Iterable<number>,
  preferred?: number | null,
): number {
  const taken = new Set(used);
  const [lo, hi] = range;
  // The port already assigned to the project is reused if it is free: port
  // stability is what lets a CDP client be configured once and for all.
  if (preferred != null && preferred >= lo && preferred <= hi && !taken.has(preferred)) {
    return preferred;
  }
  for (let p = lo; p <= hi; p++) if (!taken.has(p)) return p;
  throw new Error(`no free port in range ${lo}-${hi}`);
}

/** Ports published on the host by docker, all containers included (even stopped
 *  ones: a stopped container that restarts keeps its mapping). Crossed with the
 *  table so we never aim at a port docker will refuse to bind. */
export function publishedHostPorts(): Set<number> {
  const r = run(['ps', '-a', '--format', '{{.Ports}}'], PS_TIMEOUT_MS);
  const ports = new Set<number>();
  if (!r.ok) return ports;
  // Docker format: `127.0.0.1:9300->9222/tcp, :::8080->80/tcp`.
  for (const m of r.out.matchAll(/:(\d+)->/g)) {
    const p = Number(m[1]);
    if (Number.isFinite(p)) ports.add(p);
  }
  return ports;
}

/** Names of browser containers that are ACTUALLY running. */
export function runningBrowserContainers(): Set<string> {
  const r = run(
    ['ps', '--filter', 'label=timon.browser=1', '--format', '{{.Names}}'],
    PS_TIMEOUT_MS,
  );
  if (!r.ok) return new Set();
  return new Set(r.out.split('\n').map((s) => s.trim()).filter(Boolean));
}

/** CDP relays that are actually running. A dead relay leaves the browser up
 *  but its CDP port mute — silent failure par excellence, hence the separate
 *  check. */
export function runningProxyContainers(): Set<string> {
  const r = run(
    ['ps', '--filter', 'label=timon.browser.proxy=1', '--format', '{{.Names}}'],
    PS_TIMEOUT_MS,
  );
  if (!r.ok) return new Set();
  return new Set(r.out.split('\n').map((s) => s.trim()).filter(Boolean));
}

/** Does the container exist, even if stopped? A `docker run` on a name already
 *  taken fails, including when the container is dead. */
function containerExists(name: string): boolean {
  const r = run(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'], PS_TIMEOUT_MS);
  return r.ok && r.out.split('\n').some((n) => n.trim() === name);
}

/**
 * Docker labels set at creation. Two routers per host, like the app: a `web`
 * (http) and a `websecure` (https, tls) — the second is what the user opens from
 * `timon.localhost`, the first is what Tailscale serves after terminating TLS
 * on its side.
 *
 * `stripprefix` is required: the remote desktop is served at the container
 * root, it knows nothing of the `/browser/<slug>` Traefik adds.
 *
 * Exported for tests — a malformed label does not break startup, it just makes
 * the page unfindable, which is very hard to diagnose.
 */
export function traefikLabels(slug: string): string[] {
  const name = routerName(slug);
  const path = browserPath(slug);
  const labels = [
    'traefik.enable=true',
    // Ownership marker: used as a reconciliation filter, and avoids relying
    // on the name prefix alone to decide a container is ours.
    'timon.browser=1',
    `timon.browser.project=${slug}`,
    `traefik.http.middlewares.${name}-strip.stripprefix.prefixes=${path}`,
    // Redirect to the trailing slash BEFORE the strip. The remote desktop serves
    // its assets as RELATIVE paths (`./assets/…`): without a trailing slash, the
    // browser resolves them on `/browser/assets/…` — outside the prefix, hence 404 and
    // a blank page. The page itself answers 200, which makes the failure
    // perfectly silent (verified by hand: 200 on the page, 404 on the asset).
    `traefik.http.middlewares.${name}-slash.redirectregex.regex=^(https?://[^/]+)${path}$`,
    `traefik.http.middlewares.${name}-slash.redirectregex.replacement=\${1}${path}/`, // portability: URL path in a Traefik label
    `traefik.http.services.${name}.loadbalancer.server.port=${webPort()}`,
  ];
  const hostList = hosts();
  if (!hostList.length) return labels;

  // `Host(a) || Host(b)`: a single rule for every host, rather than one
  // router per host — same service, same middlewares, nothing to desynchronize.
  const rule = `(${hostList.map((h) => `Host(\`${h}\`)`).join(' || ')}) && PathPrefix(\`${path}\`)`;
  labels.push(
    `traefik.http.routers.${name}.rule=${rule}`,
    `traefik.http.routers.${name}.entrypoints=web`,
    `traefik.http.routers.${name}.middlewares=${name}-slash,${name}-strip`,
    `traefik.http.routers.${name}.service=${name}`,
    `traefik.http.routers.${name}-secure.rule=${rule}`,
    `traefik.http.routers.${name}-secure.entrypoints=websecure`,
    `traefik.http.routers.${name}-secure.tls=true`,
    `traefik.http.routers.${name}-secure.middlewares=${name}-slash,${name}-strip`,
    `traefik.http.routers.${name}-secure.service=${name}`,
  );
  return labels;
}

/**
 * Mount the project folder, **read-only**, at a path the agent can address.
 * Both properties matter, for two different reasons:
 *
 *  - addressable path: the browser resolves `upload_file` paths INSIDE the
 *    container, and Chromium accepts a missing path by attaching a 0-byte file,
 *    with no error at all. On Linux and macOS the mount keeps the SAME absolute
 *    path as on the host, so an agent's path is valid on both sides as is. On
 *    Windows a drive path is not a Linux path: the target is translated
 *    (`D:\Projects\X` → `/host/d/Projects/X`, see `browser-container-paths.ts`)
 *    and the MCP relay translates uploaded paths the same way (TIM-0120);
 *  - read-only: the browser executes hostile code by nature. It must be able to
 *    READ a fixture to upload it, never write into the repo.
 *
 * `--mount`, not `-v`: `-v` splits its spec on `:`, which a drive letter
 * (`D:\…`) breaks — docker answered "too many colons" and no browser started.
 *
 * Nothing is mounted if the project has no known `cwd` or it has vanished from
 * disk: otherwise docker would create an empty root-owned folder in its place.
 */
export function projectMountArgs(
  projectPath?: string | null,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (!projectPath || !exists(projectPath)) return [];
  const mount = containerProjectMount(projectPath, platform);
  if (!mount) return [];
  const fields = ['type=bind', `source=${mount.source}`, `target=${mount.target}`, 'readonly'];
  return ['--mount', fields.map(csvField).join(',')];
}

/** `--mount` is parsed as one CSV record: a field holding `,` or `"` is quoted. */
function csvField(field: string): string {
  return /[",]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

/**
 * Make sure the browser's docker network exists before `docker run` joins it.
 * On a machine without the Compose stack (packaged install, renamed network),
 * `traefik_network` is absent and docker only answers a raw "network … not
 * found". The browser needs the network for Traefik's label routing only, so a
 * plain bridge network is enough: we create it.
 *
 * No stderr parsing: an `inspect` failure may also mean docker is down. A
 * failed `create` is followed by a second `inspect` — a concurrent start may
 * have created it in between ("already exists") — and only then do we throw,
 * relaying docker's own message so a stopped daemon is not mistaken for a
 * settings problem. `exec` is injectable so this is testable without docker.
 */
export function ensureBrowserNetwork(
  net: string,
  exec: (args: string[], timeout: number) => Run = run,
): void {
  if (exec(['network', 'inspect', net], PS_TIMEOUT_MS).ok) return;
  const created = exec(['network', 'create', net], STOP_TIMEOUT_MS);
  if (created.ok) {
    console.warn(`[browser] docker network "${net}" was missing: created`);
    return;
  }
  if (exec(['network', 'inspect', net], PS_TIMEOUT_MS).ok) return;
  throw new Error(
    `cannot use or create the docker network "${net}" for the embedded browser`
    + ` (${created.err || 'docker network create failed'}). Check that docker is running,`
    + ` or set Settings → Infra → Browser docker network (TIMON_BROWSER_NETWORK) to an existing network.`,
  );
}

/** Full `docker run` arguments. Exported so tests can check the guard that
 *  actually matters: the CDP bind on loopback. */
export function runArgs(slug: string, cdpPort: number, projectPath?: string | null): string[] {
  const name = containerName(slug);
  const args = [
    'run', '-d',
    '--name', name,
    // No `--restart unless-stopped`: a browser is opened on demand,
    // it must not resurrect on its own at machine reboot.
    '--restart', 'no',
    '--network', network(),
    // Chromium writes its render buffers in /dev/shm; docker's default 64 MB
    // makes it crash as soon as a page is a bit heavy.
    '--shm-size', '1g',
    '--security-opt', 'seccomp=unconfined',
    // ⚠️ The explicit bind on 127.0.0.1 is THE guard of this module: without the
    // address prefix, docker publishes on 0.0.0.0 and the debug port — total
    // control of the browser, authenticated sessions included, with no auth — becomes
    // reachable from the whole local network and from Tailscale.
    '-p', `127.0.0.1:${cdpPort}:${CDP_PROXY_PORT}`,
    '-v', `${browserProfileDir(slug)}:/config`,
    ...projectMountArgs(projectPath),
    '-e', `PUID=${process.getuid?.() ?? 1000}`,
    '-e', `PGID=${process.getgid?.() ?? 1000}`,
    '-e', `TZ=${process.env.TZ || 'Europe/Paris'}`,
    // No `--remote-debugging-address`: Chromium has ignored it since M111, it
    // listens on the container loopback anyway. The socat relay is what
    // makes the debugger reachable (see header, invariant 2).
    '-e', `CHROME_CLI=--remote-debugging-port=${CDP_CONTAINER_PORT}`,
  ];
  for (const l of traefikLabels(slug)) args.push('--label', l);
  args.push(image());
  return args;
}

/**
 * CDP relay arguments. `--network container:<browser>`: the relay has NO
 * network stack of its own, it shares the browser's — that is what lets it
 * reach `127.0.0.1:9222` and, above all, what makes the port published by the
 * BROWSER land on it. Corollary: the relay cannot publish a port itself (docker
 * refuses), and it must be removed BEFORE the browser it depends on.
 */
export function proxyArgs(slug: string): string[] {
  return [
    'run', '-d',
    '--name', proxyName(slug),
    '--restart', 'no',
    '--network', `container:${containerName(slug)}`,
    '--label', 'timon.browser.proxy=1',
    '--label', `timon.browser.project=${slug}`,
    proxyImage(),
    `tcp-listen:${CDP_PROXY_PORT},fork,reuseaddr`,
    `tcp:127.0.0.1:${CDP_CONTAINER_PORT}`,
  ];
}

/**
 * Web relay: the browser loopback towards Traefik.
 *
 * Without it, no local site is reachable from the container. `*.localhost` is
 * reserved to loopback by RFC 6761, and every resolver — glibc as well as
 * Chromium's internal resolver — decides it without ever querying DNS:
 * `nimbus.localhost` therefore points at the CONTAINER's loopback, where nothing
 * listens. Neither `/etc/hosts` nor a network alias on Traefik changes anything,
 * since no DNS query is issued. `--host-resolver-rules` would fix it on the
 * Chromium side, but the rule contains spaces and the image injects it via an
 * unquoted `${CHROME_CLI}` that would split it into pieces.
 *
 * So we take the problem from the other end: since every `*.localhost` lands on
 * loopback, we put Traefik AT THE END of that loopback. A single relay covers
 * every vhost, present and future, with no list to keep up to date — this is
 * pure TCP, routing happens on the `Host` header (or SNI on 443) that the
 * browser already sends.
 *
 * Assumed trade-off: this browser reaches EVERY local site on the machine. That
 * is the intended goal, but it is worth knowing — a hostile page it opens can
 * hit those sites too.
 */
export function webProxyArgs(slug: string): string[] {
  const relays = WEB_PORTS.map(
    (port) =>
      `socat TCP-LISTEN:${port},fork,reuseaddr,bind=127.0.0.1 TCP:${traefikHost()}:${port} &`,
  ).join(' ');
  return [
    'run', '-d',
    '--name', webProxyName(slug),
    '--restart', 'no',
    // Same network stack as the browser: that is what makes this `bind` on
    // 127.0.0.1 ITS own loopback. Same corollary as the CDP relay — it
    // must be removed before the browser.
    '--network', `container:${containerName(slug)}`,
    '--label', 'timon.browser.proxy=1',
    '--label', `timon.browser.project=${slug}`,
    // The image entrypoint is `socat`: a shell is needed to launch two of them
    // (one socat only listens on one port).
    '--entrypoint', 'sh',
    proxyImage(),
    '-c', `${relays} wait`,
  ];
}

function enrich(row: BrowserSessionRow): BrowserSession {
  return {
    ...row,
    cdp_url: `http://127.0.0.1:${row.cdp_port}`,
    url: (() => { const hs = hosts(); return hs.length ? `https://${hs[0]}${browserPath(row.project)}` : null; })(),
  };
}

/** Minimum interval between two Docker checks (no need to hit Docker more often
 *  than the frontend poll — 20 s). */
const VERIFY_THROTTLE_MS = 5_000;
let lastVerifyAt = 0;

/**
 * Live-check that DB statuses match the living Docker containers. Unlike
 * `reconcileBrowserSessions`, this version restarts NOTHING (no proxy, no
 * container): it only realigns the database, which makes it fast enough to be
 * called on every API request. Throttled to 5 s so we do not hammer docker on
 * every concurrent call.
 */
export function verifyBrowserStatuses(): void {
  const now = Date.now();
  if (now - lastVerifyAt < VERIFY_THROTTLE_MS) return;
  lastVerifyAt = now;
  const rows = dbApi.listBrowserSessions();
  if (!rows.length) return;
  const live = runningBrowserContainers();
  const { toStop, toStart } = diffSessions(rows, live);
  for (const project of toStop) {
    dbApi.setBrowserSessionStatus(project, 'stopped');
  }
  for (const project of toStart) {
    const known = rows.find((r) => r.project === project)?.started_at;
    dbApi.setBrowserSessionStatus(project, 'running', known ?? Date.now());
  }
}

// Give `browser-mcp.ts` back the Docker realignment its old resolution path
// (`getBrowserSession`) used to do for it. Without this line, the MCP
// could be wired to a dead container's port — silent failure.
setBrowserStatusVerifier(verifyBrowserStatuses);

export function getBrowserSession(slug: string, viewer?: DbViewer | null): BrowserSession | null {
  if (!isValidSlug(slug)) return null;
  verifyBrowserStatuses();
  const row = dbApi.getBrowserSession(slug, viewer);
  return row ? enrich(row) : null;
}

export function listBrowserSessions(viewer?: DbViewer | null): BrowserSession[] {
  verifyBrowserStatuses();
  return dbApi.listBrowserSessions(viewer).map(enrich);
}

/** Longest docker stderr relayed: enough for any daemon message, never a dump. */
const DOCKER_ERROR_MAX = 1000;

/**
 * Error for a failed `docker run`, carrying docker's own stderr (TIM-0120: the
 * real reason, "mount denied … too many colons", only showed in a raw console).
 * It is also logged, since the HTTP caller may not surface it. No secret can
 * leak: the run arguments carry none, and docker only echoes those.
 */
export function dockerRunError(slug: string, what: string, r: Run): Error {
  const detail = r.err.trim().slice(0, DOCKER_ERROR_MAX) || `exit without a message`;
  console.warn(`[browser] docker run of the ${what} for ${slug} failed: ${detail}`);
  return new Error(`docker run of the ${what} failed: ${detail}`);
}

/**
 * Start the project's browser, or return the existing session if it is already
 * running (idempotent: two quick clicks do not create two containers).
 */
export async function startBrowserSession(slug: string, viewer?: DbViewer | null): Promise<BrowserSession> {
  assertSlug(slug);
  const name = containerName(slug);

  const existing = dbApi.getBrowserSession(slug);
  if (existing?.status === 'running' && runningBrowserContainers().has(name)) {
    return enrich(existing);
  }

  // Leftover of a previous cycle (stopped container never cleaned, or crash between
  // the run and the database write): `docker run` would refuse the name. The relay
  // goes FIRST: docker refuses to remove a container whose network stack
  // is borrowed by another.
  if (containerExists(proxyName(slug))) run(['rm', '-f', proxyName(slug)], STOP_TIMEOUT_MS);
  if (containerExists(webProxyName(slug))) run(['rm', '-f', webProxyName(slug)], STOP_TIMEOUT_MS);
  if (containerExists(name)) run(['rm', '-f', name], STOP_TIMEOUT_MS);

  const used = publishedHostPorts();
  for (const p of dbApi.reservedBrowserCdpPorts(slug)) used.add(p);
  const cdpPort = allocatePort(CDP_PORT_RANGE, used, existing?.cdp_port ?? null);

  // The profile directory must exist BEFORE the mount: otherwise docker would
  // create it itself as root, and the linuxserver image (which runs as PUID/PGID)
  // could no longer write there.
  mkdirSync(browserProfileDir(slug), { recursive: true });

  // The general browser has no project directory to mount.
  const projectPath = slug === GENERAL_BROWSER_SLUG ? undefined : readMeta(slug).cwd;
  ensureBrowserNetwork(network());
  const r = run(runArgs(slug, cdpPort, projectPath), RUN_TIMEOUT_MS);
  if (!r.ok) throw dockerRunError(slug, 'browser', r);

  // Web relay: best-effort, unlike the CDP relay. Without it local sites are
  // out of reach, but the browser stays fully usable (public web, CDP steering) —
  // stopping everything for that would be disproportionate.
  const web = run(webProxyArgs(slug), RUN_TIMEOUT_MS);
  if (!web.ok) {
    console.warn(`[browser] web relay unavailable for ${slug}: ${web.err || 'docker run failed'}`);
  }

  const proxy = run(proxyArgs(slug), RUN_TIMEOUT_MS);
  if (!proxy.ok) {
    // Without a relay, the browser runs but its CDP port does not answer: a
    // half-success is worse than a failure here, it is only diagnosed at the first
    // mute MCP call. Undo everything and surface the error.
    run(['rm', '-f', name], STOP_TIMEOUT_MS);
    throw dockerRunError(slug, 'CDP relay', proxy);
  }

  const session = enrich(dbApi.upsertBrowserSession({
    project: slug,
    containerName: name,
    cdpPort,
    novncPort: webPort(),
    status: 'running',
    startedAt: Date.now(),
    stoppedAt: null,
    ownerUserId: viewer?.id ?? null,
  }));

  // Restore safety net: never allowed to fail the start — the
  // browser is already fully usable even if its old tabs do not
  // come back (see `restoreOpenTabs`, which is itself best-effort end
  // to end; this try/catch is a second belt, not the first).
  try {
    await restoreOpenTabs(slug, session.cdp_url);
  } catch (err) {
    console.warn(`[browser] ${slug} : tab restoration failed (${(err as Error).message})`);
  }

  return session;
}

/**
 * Stop and remove the container. The on-disk profile and the database row
 * SURVIVE: the first holds the session, the second the assigned port.
 */
export async function stopBrowserSession(slug: string): Promise<void> {
  assertSlug(slug);
  const name = containerName(slug);

  // Captured BEFORE touching the container: it is now, while CDP still
  // answers, that the open tabs exist somewhere reachable.
  const existing = dbApi.getBrowserSession(slug);
  if (existing?.status === 'running') await captureOpenTabs(slug, existing.cdp_port);

  // The relay borrows the browser's network stack: removing it second
  // would make removing the browser fail (network dependency).
  if (containerExists(proxyName(slug))) run(['rm', '-f', proxyName(slug)], STOP_TIMEOUT_MS);
  if (containerExists(webProxyName(slug))) run(['rm', '-f', webProxyName(slug)], STOP_TIMEOUT_MS);

  if (containerExists(name)) {
    const stopped = run(['stop', name], STOP_TIMEOUT_MS);
    // `stop` may fail on an already-dead container: that is not an error,
    // only a failed `rm` would prevent a later restart (name taken).
    const removed = run(['rm', '-f', name], STOP_TIMEOUT_MS);
    if (!removed.ok) throw new Error(removed.err || stopped.err || 'docker rm failed');
  }

  dbApi.setBrowserSessionStatus(slug, 'stopped');

  // Natural path, set AFTER confirming the container is actually dead:
  // that is what triggers Chromium's NATIVE restore on the next
  // start, without having to replay each tab by hand.
  patchPreferencesForRestore(slug);
}

/**
 * Gap between what the database claims and what docker is actually running.
 *
 * PURE function (see `allocatePort`): reconciliation is exactly the kind of
 * code one never exercises by hand, so it must be testable without starting a
 * container.
 *
 * Two directions, because both drifts happen:
 *  - `toStop`: the database says `running`, the container no longer exists
 *    (docker crash, manual `docker rm`, machine reboot). Without a fix, the UI
 *    would offer to open a dead browser and the MCP would target a closed port.
 *  - `toStart`: the container is running, the database says `stopped`
 *    (orchestrator killed between `docker run` and the write). Without a fix,
 *    the next start would destroy a perfectly alive browser — in-progress
 *    session included.
 */
export function diffSessions(
  rows: readonly Pick<BrowserSessionRow, 'project' | 'container_name' | 'status'>[],
  liveContainers: ReadonlySet<string>,
): { toStop: string[]; toStart: string[] } {
  const toStop: string[] = [];
  const toStart: string[] = [];
  for (const row of rows) {
    const live = liveContainers.has(row.container_name);
    if (row.status === 'running' && !live) toStop.push(row.project);
    else if (row.status !== 'running' && live) toStart.push(row.project);
  }
  return { toStop, toStart };
}

/**
 * Reconciliation rule (see reconcile.ts): the table reflects docker's real
 * state. Idempotent, silent when everything is aligned.
 */
export function reconcileBrowserSessions(): void {
  const rows = dbApi.listBrowserSessions();
  if (!rows.length) return;

  // `docker ps` failing (daemon stopped) yields an empty set, indistinguishable
  // from "no browser is running": we would then wrongly mark everything `stopped`.
  // So we only take a position if docker answers.
  const probe = run(['ps', '--format', '{{.Names}}'], PS_TIMEOUT_MS);
  if (!probe.ok) return;

  const live = runningBrowserContainers();
  const proxies = runningProxyContainers();

  const { toStop, toStart } = diffSessions(rows, live);
  for (const project of toStop) {
    dbApi.setBrowserSessionStatus(project, 'stopped');
    console.log(`[browser] ${project} : container not found, session marked stopped`);
  }

  // Browser up but relay dead: CDP goes mute, local sites unreachable — two
  // failures nothing reports. Relays are stateless, restarting them costs
  // nothing and touches neither the browser nor its session.
  for (const row of rows) {
    if (!live.has(row.container_name)) continue;
    const relays = [
      { kind: 'CDP', name: proxyName(row.project), args: proxyArgs(row.project) },
      { kind: 'web', name: webProxyName(row.project), args: webProxyArgs(row.project) },
    ];
    for (const relay of relays) {
      if (proxies.has(relay.name)) continue;
      if (containerExists(relay.name)) run(['rm', '-f', relay.name], STOP_TIMEOUT_MS);
      const r = run(relay.args, RUN_TIMEOUT_MS);
      console.log(
        `[browser] ${row.project} : ${relay.kind} relay ${r.ok ? 'restarted' : `unreachable (${r.err})`}`,
      );
    }
  }

  for (const project of toStart) {
    // Keep the known `started_at`: the container was already running before this
    // pass, overwriting it with "now" would lie about the displayed duration.
    const known = rows.find((r) => r.project === project)?.started_at;
    dbApi.setBrowserSessionStatus(project, 'running', known ?? Date.now());
    console.log(`[browser] ${project} : live container, session marked running`);
  }
}

export type { BrowserSessionStatus };

/* ────────────────────────────────────────────────────────────────────────────
   Activity and automatic close.

   Three signal sources, crossed rather than a single one: a bad signal kills a
   live session, exactly what the old doctrine (see header) feared — the error
   direction that matters here is to spare wrongly, never to close wrongly.

     1. Agent usage: every MCP config that wires an agent onto the project's CDP
        at spawn (see dialects) bumps the project — even if the agent never uses
        it afterwards, the intent to use it counted.
     2. Detected navigation: `/json/list` queried on every sweep, hashed,
        compared to the previous pass — covers the human AND the agent, including
        an agent that navigates via chrome-devtools-mcp without ever calling
        `chromeDevtoolsMcpEntry` again (resolved once, at spawn).
     3. Connected Selkies spectator: an ESTABLISHED connection to the container's
        INTERNAL web port (visible only from the inside, via `docker exec` — this
        port is not published on the host, see header invariant 3) means a remote
        desktop is open somewhere. ASYMMETRIC signal and assumed as such: Traefik's
        keep-alive connection pool can wrongly count as "someone is watching" —
        never the reverse, a session that is actually being watched cannot look
        idle. No more reliable signal found without instrumenting Selkies itself
        (out of scope of this project): this is a known limit, not a heuristic
        invented to fill a gap.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Has a session passed the idle threshold? PURE function — the calculation that
 * matters, testable without docker or a real clock (see `allocatePort` for the
 * same discipline).
 *
 * `last_used_at` falls back to `started_at` when nothing has bumped the session
 * yet: a session opened two minutes ago is never overdue, even with no observed
 * activity signal. If NEITHER exists (should never happen: `started_at` is always
 * set at insert), we refuse to close rather than guess a reference.
 */
export function isIdleExpired(
  row: Pick<BrowserSessionRow, 'last_used_at' | 'started_at'>,
  now: number,
  idleMinutes: number,
): boolean {
  if (!Number.isFinite(idleMinutes) || idleMinutes <= 0) return false;
  const reference = row.last_used_at ?? row.started_at;
  if (reference == null) return false;
  return now - reference >= idleMinutes * 60_000;
}

/** Bump the activity signal of a RUNNING browser. Silent no-op on a project
 *  with no session or already stopped (see `dbApi.touchBrowserSessionActivity`)
 *  — a late signal must never resurrect an extinguished row. */
export function touchBrowserSessionActivity(slug: string, at: number = Date.now()): void {
  dbApi.touchBrowserSessionActivity(slug, at);
}


/** Subset of `/json/list` we care about: a real page, not a worker or a
 *  devtools panel that the protocol also lists. */
type CdpPage = { id: string; type: string; url: string; title: string };

async function cdpFetch<T>(cdpUrl: string, path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CDP_HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(`${cdpUrl}${path}`, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new Error(`CDP ${path}: HTTP ${r.status}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** `about:blank` and internal pages (`chrome://`, `devtools://`…) carry no
 *  restore intent: counting them as a tab would inflate the list without helping
 *  the next restart, and `about:blank` in particular would make a browser that
 *  has just started with nothing opened look "in progress". */
export function isRestorablePage(t: Pick<CdpPage, 'type' | 'url'>): boolean {
  if (t.type !== 'page') return false;
  if (!t.url || t.url === 'about:blank') return false;
  return !/^(chrome|devtools|chrome-extension|edge):/i.test(t.url);
}

async function listCdpPages(cdpUrl: string): Promise<CdpPage[]> {
  const list = await cdpFetch<CdpPage[]>(cdpUrl, '/json/list');
  return list.filter(isRestorablePage);
}

/** Fingerprint of open pages, insensitive to tab ORDER (sorting avoids a mere
 *  rearrangement — dragging a tab next to another — wrongly counting as
 *  navigation). Title included: it often changes after a page whose URL stays
 *  stable has loaded (an SPA for example), and that is precisely the kind of
 *  navigation we want to catch. */
export function hashPages(pages: readonly Pick<CdpPage, 'url' | 'title'>[]): string {
  const sig = pages.map((p) => `${p.url} ${p.title}`).sort().join('');
  return createHash('sha1').update(sig).digest('hex');
}

/** Fingerprint of the previous pass, per project. In memory and NOT persisted:
 *  this is an EPHEMERAL signal ("did we move since the last sweep"), not state
 *  that must survive an orchestrator restart — at worst, the first sweep after a
 *  restart starts with no reference (see below) and the next one detects normally
 *  again. */
const lastPageHash = new Map<string, string>();

/**
 * Bump the project's activity if the open tabs have changed since the last
 * sweep. The very first pass (after a restart, or for a browser that just
 * appeared) has nothing to compare: it only sets the reference, WITHOUT bumping
 * — otherwise every live browser would get a free stay of execution on the sweep
 * that follows an orchestrator restart, which would empty the threshold of its
 * meaning for the whole next window.
 */
async function detectNavigationActivity(project: string, cdpUrl: string): Promise<void> {
  let pages: CdpPage[];
  try {
    pages = await listCdpPages(cdpUrl);
  } catch {
    // Mute CDP: neither proof of activity nor proof of inactivity. Touch
    // nothing, silently — a warning here would fire on every sweep for a
    // browser that is simply starting or stopping.
    return;
  }
  const hash = hashPages(pages);
  const previous = lastPageHash.get(project);
  lastPageHash.set(project, hash);
  if (previous !== undefined && previous !== hash) touchBrowserSessionActivity(project);
}

/**
 * Is a spectator connected to the project's remote desktop? Looked up INSIDE the
 * container (`docker exec … cat /proc/net/tcp`), because that is the only place
 * the connection exists: the web port is internal (see header invariant 3),
 * Traefik reaches it over the docker network, the orchestrator (host mode) has
 * no other view of it.
 *
 * `cat` rather than `ss` or `netstat`: present in almost every Linux image,
 * unlike the other two which depend on network packages not necessarily installed
 * in a minimal image like the browser's.
 */
export function hasConnectedViewer(container: string): boolean {
  const r = run(['exec', container, 'cat', '/proc/net/tcp', '/proc/net/tcp6'], PS_TIMEOUT_MS);
  if (!r.ok) return false; // no proof → no stay of execution, see section above
  const portHex = webPort().toString(16).toUpperCase().padStart(4, '0');
  return r.out
    .split('\n')
    .some((line) => {
      const cols = line.trim().split(/\s+/);
      const localAddr = cols[1]; // e.g. "0100007F:0BB8" (address:port in hex)
      const state = cols[3]; // "01" = ESTABLISHED (see include/net/tcp_states.h)
      return localAddr?.endsWith(`:${portHex}`) && state === '01';
    });
}

/**
 * Periodic sweep: updates the activity signal of every live browser, then closes
 * those that have passed the threshold. Registered as a `reconcile.ts` rule
 * (`interval` cadence) rather than its own loop: this is exactly the module's
 * pattern — an invariant ("no browser stays open more than N minutes with nobody
 * there") checked and corrected periodically — not a separate infra.
 */
export async function closeIdleBrowserSessions(): Promise<void> {
  const running = dbApi.listBrowserSessions().filter((r) => r.status === 'running');
  if (!running.length) return;

  for (const row of running) {
    const cdpUrl = `http://127.0.0.1:${row.cdp_port}`;
    await detectNavigationActivity(row.project, cdpUrl);
    if (hasConnectedViewer(row.container_name)) touchBrowserSessionActivity(row.project);
  }

  const idleMinutes = idleMinutesSetting();
  if (idleMinutes <= 0) return; // close disabled: the signal stays up to date, we just do not act on it

  const now = Date.now();
  // Re-read from the database: the `touchBrowserSessionActivity` calls above may
  // have moved `last_used_at` since the `running` captured earlier.
  for (const row of dbApi.listBrowserSessions()) {
    if (row.status !== 'running') continue;
    if (!isIdleExpired(row, now, idleMinutes)) continue;
    console.log(`[browser] ${row.project} : ${idleMinutes} minutes inactive, closing automatically`);
    try {
      await stopBrowserSession(row.project);
    } catch (err) {
      console.error(`[browser] ${row.project}: automatic close failed: ${(err as Error).message}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   Tab restore — natural path (Preferences) + safety net (CDP).
   ──────────────────────────────────────────────────────────────────────────── */

type ChromiumPreferences = {
  profile?: { exit_type?: string; [k: string]: unknown };
  session?: { restore_on_startup?: number; [k: string]: unknown };
  [k: string]: unknown;
};

const CHROMIUM_PROFILE_SUBDIR = '.config/chromium/Default';

function preferencesPath(slug: string): string {
  return join(browserProfileDir(slug), CHROMIUM_PROFILE_SUBDIR, 'Preferences');
}

/**
 * Rewrite `Preferences` so Chromium believes it exited cleanly and restores its
 * session ON ITS OWN at next start — native path, preferred over the CDP safety
 * net that follows: without this patch, Chromium shows "Restore pages?" (never
 * clicked, nobody in front) and opens nothing (verified on the `nimbus` profile:
 * the file written at stop carries `exit_type: "Crashed"` and `session: {}`).
 *
 * Targeted read / edit / rewrite, never a replacement: this is a large JSON of
 * which we only know a handful of keys, overwriting it would lose the rest of the
 * profile (per-site zoom, granted permissions…). Called only AFTER confirming the
 * container is stopped: while Chromium is still running it rewrites this file at
 * regular intervals and would erase our patch on the next flush.
 */
function patchPreferencesForRestore(slug: string): void {
  const path = preferencesPath(slug);
  if (!existsSync(path)) return; // first start: Chromium has not written anything yet, nothing to fix

  let prefs: ChromiumPreferences;
  try {
    prefs = JSON.parse(readFileSync(path, 'utf8')) as ChromiumPreferences;
  } catch (err) {
    console.warn(`[browser] ${slug} : Preferences unreadable, native restore compromised (${(err as Error).message})`);
    return;
  }

  prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal' };
  prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 1 };

  try {
    writeFileSync(path, JSON.stringify(prefs));
  } catch (err) {
    console.warn(`[browser] ${slug} : failed to write Preferences (${(err as Error).message})`);
  }
}

/**
 * Capture the open tabs BEFORE stopping, while CDP still answers.
 * Best-effort: an already-mute CDP (dead relay, crash) must not block the stop —
 * this is the safety net, not the main line of defence.
 */
async function captureOpenTabs(slug: string, cdpPort: number): Promise<void> {
  try {
    const pages = await listCdpPages(`http://127.0.0.1:${cdpPort}`);
    dbApi.setBrowserSessionOpenTabs(slug, pages.map((p) => ({ url: p.url, title: p.title })));
  } catch (err) {
    // We do NOT CLEAR `open_tabs` on this failure: a list captured at a previous
    // stop, even a bit dated, is better than restoring nothing.
    console.warn(`[browser] ${slug} : unable to capture tabs before shutdown (${(err as Error).message})`);
  }
}

export type StoredTab = { url: string; title: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStoredTab(v: unknown): v is StoredTab {
  return isRecord(v) && typeof v.url === 'string' && typeof v.title === 'string';
}

/** Read `open_tabs` (JSON stored in the database) while tolerating anything that
 *  no longer has the expected shape — a format that changed one day must never
 *  crash a start, just make restore silently empty. */
export function parseStoredTabs(raw: string | null): StoredTab[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStoredTab) : [];
  } catch {
    return [];
  }
}

/**
 * Stored tabs that are still missing among the currently open pages.
 * PURE function: this is what avoids DOUBLING a tab Chromium already restored
 * on its own (natural path) — comparison on the EXACT URL, not a subset: one
 * extra `?utm=` would give a false "missing" and open a duplicate anyway.
 */
export function missingTabs(
  stored: readonly StoredTab[],
  currentlyOpen: readonly Pick<CdpPage, 'url'>[],
): StoredTab[] {
  const open = new Set(currentlyOpen.map((p) => p.url));
  return stored.filter((t) => !open.has(t.url));
}

async function waitForCdpReady(cdpUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await cdpFetch(cdpUrl, '/json/version');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, CDP_READY_POLL_MS));
    }
  }
  return false;
}

/**
 * Restore safety net: reopen what Chromium did not restore on its own.
 * Best-effort end to end — never throws, only warnings — because a failure here
 * must never fail `startBrowserSession`: the browser is usable even without its
 * old tabs.
 */
async function restoreOpenTabs(slug: string, cdpUrl: string): Promise<void> {
  const row = dbApi.getBrowserSession(slug);
  const stored = parseStoredTabs(row?.open_tabs ?? null);
  if (!stored.length) return;

  const ready = await waitForCdpReady(cdpUrl, CDP_READY_TIMEOUT_MS);
  if (!ready) {
    console.warn(`[browser] ${slug} : CDP never became reachable, abandoning tab restoration`);
    return;
  }
  // CDP answers as soon as the process is up; NATIVE restore may still be
  // creating tabs a handful of seconds later.
  await new Promise((r) => setTimeout(r, RESTORE_SETTLE_MS));

  let open: CdpPage[];
  try {
    open = await listCdpPages(cdpUrl);
  } catch (err) {
    console.warn(`[browser] ${slug} : /json/list failed, abandoning tab restoration (${(err as Error).message})`);
    return;
  }

  const missing = missingTabs(stored, open);
  for (const tab of missing) {
    try {
      await cdpFetch(cdpUrl, `/json/new?${new URLSearchParams({ url: tab.url })}`, { method: 'PUT' });
    } catch (err) {
      console.warn(`[browser] ${slug} : failed to reopen "${tab.url}" (${(err as Error).message})`);
    }
  }
  // Consumed: the next stop will recapture the REAL tab state at that
  // moment rather than replaying this same list forever.
  dbApi.setBrowserSessionOpenTabs(slug, null);
  console.log(`[browser] ${slug} : ${missing.length}/${stored.length} tab(s) reopened via the safety net`);
}

