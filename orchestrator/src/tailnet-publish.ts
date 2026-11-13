/**
 * "Make this machine reachable": publish THIS daemon on the tailnet with
 * `tailscale serve`, so another computer can pair with it (Machines).
 *
 * The one act next to `web-access.ts`, which only looks. Its limits are the
 * point of the module:
 *
 *  - `serve`, never `funnel`: the daemon is published to the tailnet, never to
 *    the internet. No argv built here contains `funnel`.
 *  - An existing handler is never overwritten. A port is free only when the
 *    serve config holds nothing on it at all — a TCP forward or a single path
 *    is enough to take it (on the maintainer's machine 443 serves the web UI and 8443 one
 *    webhook path).
 *  - Idempotent: a root handler that already forwards to this daemon on the
 *    loopback is the answer, and nothing runs.
 *  - The address returned is read back from `serve status` after the command,
 *    never assumed from its exit code, with the very rule the screen applies
 *    (`pairingAddress`, `app/src/lib/webui-access.ts`).
 *
 * Every failure is typed and carries, when one exists, the command a person
 * can run themselves on this machine. That command is display only: nothing
 * here ever executes a string.
 */
import { basename } from 'node:path';
import { config } from './config/load.js';
import { whichBin } from './doctor.js';
import { getHost } from './host/index.js';
import type { ExecResult } from './host/types.js';
import { installCommandFor } from './host/machine.js';
import { tailscaleCliOpts } from './host/tailscale-cli.js';
import { hostMachine, parseTailscaleServe, parseTailscaleStatus } from './web-access.js';

/**
 * The HTTPS ports Tailscale accepts for a published service, in order of
 * preference. 443 last: it is where the docs publish the web interface
 * (`remote-access.md`, `headless-server.md`), and a daemon taken there first
 * would be overwritten by the person following that recipe next.
 */
export const SERVE_HTTPS_PORTS = [8443, 10000, 443] as const;

export type TailnetPublishFailure =
  /** No `tailscale` binary on this machine. */
  | 'not_installed'
  /** Installed, but the node is not logged in / not running. */
  | 'not_connected'
  /** HTTPS certificates (Serve) are not enabled on the tailnet yet. */
  | 'serve_disabled'
  /** The CLI may not change the serve config: Linux without `--operator`, Windows without admin rights. */
  | 'permission'
  /** 443, 8443 and 10000 all carry something already. */
  | 'no_free_port'
  /** The CLI exited 0 without the JSON it was asked for (macOS app bundle started as the GUI). */
  | 'unreadable'
  /** The daemon listens on an address a loopback relay cannot reach. */
  | 'listen_not_loopback'
  | 'failed';

export type TailnetPublishResult =
  | { ok: true; address: string; port: number; reused: boolean }
  | {
    ok: false;
    reason: TailnetPublishFailure;
    /** OS of the daemon's machine: the screen words the elevation for it. */
    platform: NodeJS.Platform;
    /** What to run by hand on this machine, `null` when no command fixes it. */
    command: string | null;
    /** Admin console page that turns Serve on, when tailscale printed one. */
    enableUrl: string | null;
    /** First line tailscale wrote, for `failed` only. */
    detail: string | null;
  };

export type TailnetPublishDeps = {
  platform: NodeJS.Platform;
  /** Resolved `tailscale` binary, `null` when absent. */
  binary: string | null;
  daemonHost: string;
  daemonPort: number;
  run(binary: string, args: string[]): Promise<ExecResult>;
};

const STATUS_TIMEOUT_MS = 10_000;
/** `serve` may block waiting for Serve to be enabled in the admin console: bounded, and that wait is a typed answer. */
const SERVE_TIMEOUT_MS = 20_000;
const DETAIL_MAX = 200;

const LOOPBACK_TARGET_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Where the serve handler forwards: the daemon on the loopback, or `null` if it is not listening there. */
export function daemonTarget(host: string, port: number): string | null {
  if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '::') return `http://127.0.0.1:${port}`;
  if (host === '::1') return `http://[::1]:${port}`;
  return null;
}

/** Ports the serve config already uses, whatever for. */
export function servedPorts(payload: unknown): Set<number> {
  const root = (payload ?? {}) as { TCP?: unknown; Web?: unknown };
  const ports = new Set<number>();
  if (root.TCP && typeof root.TCP === 'object') {
    for (const key of Object.keys(root.TCP)) {
      const port = Number(key);
      if (Number.isInteger(port)) ports.add(port);
    }
  }
  if (root.Web && typeof root.Web === 'object') {
    for (const key of Object.keys(root.Web)) {
      const port = Number(/:(\d+)$/.exec(key)?.[1]);
      if (Number.isInteger(port)) ports.add(port);
    }
  }
  return ports;
}

/** A root handler that forwards to this daemon on the loopback — `pairingAddress()`'s rule, on the daemon side. */
export function daemonServeAddress(payload: unknown, daemonPort: number): { address: string; port: number } | null {
  for (const handler of parseTailscaleServe(payload)) {
    if (handler.host.includes('/')) continue;
    let target: URL;
    let vhost: URL;
    try {
      target = new URL(handler.target);
      vhost = new URL(`https://${handler.host}`);
    } catch {
      continue;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;
    if (!LOOPBACK_TARGET_HOSTS.has(target.hostname) || target.port !== String(daemonPort)) continue;
    return { address: vhost.origin, port: vhost.port === '' ? 443 : Number(vhost.port) };
  }
  return null;
}

export function freeServePort(used: ReadonlySet<number>): number | null {
  return SERVE_HTTPS_PORTS.find((port) => !used.has(port)) ?? null;
}

/** `serve --bg --https=<port> <target>`. The one argv this module ever writes. */
export function serveArgs(port: number, target: string): string[] {
  return ['serve', '--bg', `--https=${port}`, target];
}

/** Which failure a non-zero `serve` deserves, read off what tailscale printed. */
export function classifyServeOutput(output: string): { reason: 'serve_disabled' | 'permission' | 'failed'; enableUrl: string | null } {
  const url = /https:\/\/login\.tailscale\.com\/[^\s"'<>]+/.exec(output)?.[0] ?? null;
  if (url || /serve is not enabled|https.*not enabled|enable https/i.test(output)) return { reason: 'serve_disabled', enableUrl: url };
  if (/access denied|permission denied|--operator|must be (run as )?root|requires root|administrator|elevat/i.test(output)) {
    return { reason: 'permission', enableUrl: null };
  }
  return { reason: 'failed', enableUrl: null };
}

/** How the binary is written in a command to copy: its name when it is the usual one, its path otherwise. */
function displayBinary(platform: NodeJS.Platform, binary: string | null): string {
  if (!binary) return 'tailscale';
  if (platform === 'win32') return `& "${binary}"`;
  if (binary.includes('.app/')) return `"${binary}"`;
  return basename(binary) === 'tailscale' ? 'tailscale' : `"${binary}"`;
}

/**
 * The command a person runs on this machine to do what the button could not.
 * `sudo` on Linux and on a macOS build whose `tailscaled` runs as root
 * (Homebrew); the app bundle's CLI talks to the user's own app and needs none.
 * Windows: the line is meant for a PowerShell opened as administrator, which
 * the screen says.
 */
export function manualCommand(platform: NodeJS.Platform, binary: string | null, args: string[]): string {
  const bin = displayBinary(platform, binary);
  const elevate = platform === 'linux' || (platform === 'darwin' && !(binary ?? '').includes('.app/'));
  return `${elevate ? 'sudo ' : ''}${bin} ${args.join(' ')}`;
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, DETAIL_MAX) : null;
}

async function readJson(deps: TailnetPublishDeps, binary: string, args: string[]): Promise<unknown | null> {
  const read = await readServeJson(deps, binary, args);
  return read.ok ? read.value : null;
}

/**
 * `unparsable`: the command succeeded and printed something that is not JSON.
 * That is not "not connected" nor "nothing served": the CLI did not do what
 * it was asked, and what it said instead is the only clue.
 */
type JsonRead = { ok: true; value: unknown } | { ok: false; output: string; unparsable: boolean };

/**
 * A config that could not be read is NOT an empty one: taken for "nothing
 * served", it would send `serve` onto a port that carries the web interface.
 * An empty answer (blank stdout, `{}`) is the only "nothing".
 */
async function readServeJson(deps: TailnetPublishDeps, binary: string, args: string[]): Promise<JsonRead> {
  let r: ExecResult;
  try {
    r = await deps.run(binary, args);
  } catch (err) {
    return { ok: false, output: (err as Error).message ?? '', unparsable: false };
  }
  if (r.code !== 0) return { ok: false, output: `${r.stdout}\n${r.stderr}`, unparsable: false };
  if (r.stdout.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(r.stdout) as unknown };
  } catch {
    return { ok: false, output: `${r.stdout}\n${r.stderr}`, unparsable: true };
  }
}

export async function publishDaemonOnTailnet(deps: TailnetPublishDeps): Promise<TailnetPublishResult> {
  const fail = (
    reason: TailnetPublishFailure,
    extra: { command?: string | null; enableUrl?: string | null; detail?: string | null } = {},
  ): TailnetPublishResult => ({
    ok: false,
    reason,
    platform: deps.platform,
    command: extra.command ?? null,
    enableUrl: extra.enableUrl ?? null,
    detail: extra.detail ?? null,
  });

  const target = daemonTarget(deps.daemonHost, deps.daemonPort);
  if (!target) return fail('listen_not_loopback');
  const binary = deps.binary;
  if (!binary) {
    return fail('not_installed', { command: installCommandFor('tailscale', { platform: deps.platform, packageManager: hostMachine().packageManager }) });
  }

  const statusRead = await readServeJson(deps, binary, ['status', '--json']);
  if (!statusRead.ok && statusRead.unparsable) {
    return fail('unreadable', { detail: firstLine(statusRead.output) });
  }
  const status = parseTailscaleStatus(statusRead.ok ? statusRead.value : null);
  if (status.state !== 'Running' || !status.dnsName) {
    return fail('not_connected', { command: manualCommand(deps.platform, binary, ['up']) });
  }

  const read = await readServeJson(deps, binary, ['serve', 'status', '--json']);
  if (!read.ok) {
    if (read.unparsable) return fail('unreadable', { detail: firstLine(read.output) });
    // Which ports are free is unknown: no `serve` runs, and no port is offered to copy either.
    const verdict = classifyServeOutput(read.output);
    return fail(verdict.reason === 'permission' ? 'permission' : 'failed', {
      command: manualCommand(deps.platform, binary, ['serve', 'status']),
      detail: verdict.reason === 'permission' ? null : firstLine(read.output),
    });
  }
  const before = read.value;
  const existing = daemonServeAddress(before, deps.daemonPort);
  if (existing) return { ok: true, ...existing, reused: true };

  const port = freeServePort(servedPorts(before));
  if (port === null) return fail('no_free_port');
  const args = serveArgs(port, target);
  const command = manualCommand(deps.platform, binary, args);

  let result: ExecResult;
  try {
    result = await deps.run(binary, args);
  } catch (err) {
    return fail('failed', { command, detail: firstLine((err as Error).message ?? '') });
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0) {
    const verdict = classifyServeOutput(output);
    return fail(verdict.reason, {
      command: verdict.reason === 'serve_disabled' ? null : command,
      enableUrl: verdict.enableUrl,
      detail: verdict.reason === 'failed' ? firstLine(result.stderr) ?? firstLine(result.stdout) : null,
    });
  }

  const after = daemonServeAddress(await readJson(deps, binary, ['serve', 'status', '--json']), deps.daemonPort);
  if (!after) return fail('failed', { command, detail: firstLine(output) });
  return { ok: true, ...after, reused: false };
}

/** The real machine: the configured daemon address, tailscale resolved like `web-access.ts` does. */
export function hostPublishDeps(): TailnetPublishDeps {
  const cfg = config();
  return {
    platform: process.platform,
    binary: whichBin('tailscale', cfg.host.binaries).path,
    daemonHost: cfg.daemon.listen.host,
    daemonPort: cfg.daemon.listen.port,
    run: (binary, args) => getHost().execAsync(binary, args, tailscaleCliOpts(binary, {
      timeout: args[0] === 'serve' && args[1] === '--bg' ? SERVE_TIMEOUT_MS : STATUS_TIMEOUT_MS,
    })),
  };
}

let inFlight: Promise<TailnetPublishResult> | null = null;

/**
 * One publication at a time: two clicks must not both pick the same free port
 * and race to write it.
 */
export function publishThisDaemon(deps: () => TailnetPublishDeps = hostPublishDeps): Promise<TailnetPublishResult> {
  inFlight ??= publishDaemonOnTailnet(deps()).finally(() => { inFlight = null; });
  return inFlight;
}
