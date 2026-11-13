/**
 * What reaches the web UI, and how — the facts behind the `WebUI` settings tab.
 *
 * This lives on the DAEMON, and it has to: the UI is usually served by the
 * `rooks-app` container, where `os.networkInterfaces()` answers the Docker
 * bridge address (`172.x`) and where the `tailscale` binary does not exist.
 * Computing any of this in a Next route handler would produce an answer that
 * is wrong exactly on the installation the operator is looking at.
 *
 * Read-only, and deliberately without a verdict on reachability. A serve
 * handler forwarding to `127.0.0.1:80` (Traefik) does reach a web UI listening
 * on `:3100`, through one more hop this module cannot see; claiming "not
 * exposed" there would be a confident lie. The tab shows the chain and lets
 * the operator read it. Same posture as `/api/doctor`: it looks, it never acts.
 */
import { networkInterfaces } from 'node:os';
import { config } from './config/load.js';
import { dbApi } from './db.js';
import { authIsRequired } from './plugins-bundled/http/auth.js';
import { getHost } from './host/index.js';
import { tailscaleCliOpts } from './host/tailscale-cli.js';
import type { ExecResult } from './host/types.js';
import { whichBin } from './doctor.js';
import { installCommandFor, linuxRelease, readOsRelease, type Machine } from './host/machine.js';

/** Loopback hosts a listener can be bound to. `::` / `0.0.0.0` are not here:
 *  they mean "every interface", which is the opposite answer. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Interfaces whose addresses say nothing about reaching Rooks: container
 * bridges and virtual machine taps. They are up, they have an address, and
 * typing it in a phone browser never works — listing them would drown the one
 * or two addresses that matter. Matched on the interface NAME because that is
 * what the OS gives us; a false negative only costs one extra row.
 */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|tailscale|utun)/;

/** Tailscale's own CGNAT range (100.64/10) and its IPv6 ULA prefix. Reported
 *  in the `tailscale` section instead, where they carry their DNS name. */
function isTailscaleAddress(address: string): boolean {
  if (address.startsWith('fd7a:115c:a1e0')) return true;
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  const [a, b] = [Number(parts[0]), Number(parts[1])];
  return a === 100 && b >= 64 && b <= 127;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

export type NetworkAddress = {
  iface: string;
  address: string;
  family: 'ipv4' | 'ipv6';
};

/** Addresses of this machine a browser on the same network could try. */
export function hostAddresses(
  interfaces: NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]> = networkInterfaces(),
): NetworkAddress[] {
  const rows: NetworkAddress[] = [];
  for (const [iface, addresses] of Object.entries(interfaces)) {
    if (!addresses || VIRTUAL_IFACE.test(iface)) continue;
    for (const info of addresses) {
      if (info.internal) continue;
      // Link-local IPv6 carries a zone index (`%eth0`) and is useless pasted
      // into a URL bar; the same goes for IPv4 autoconfiguration.
      if (info.address.startsWith('fe80:') || info.address.startsWith('169.254.')) continue;
      if (isTailscaleAddress(info.address)) continue;
      rows.push({
        iface,
        address: info.address,
        // Read off the address, not `info.family`: that field has been a
        // string since Node 18 and a number before, and the colon is the one
        // discriminator no runtime version can change.
        family: info.address.includes(':') ? 'ipv6' : 'ipv4',
      });
    }
  }
  return rows;
}

export type ServeHandler = {
  /** Tailnet vhost the handler answers on, port included. */
  host: string;
  /** Where it forwards — a local URL, or a served path. */
  target: string;
};

export type TailscaleReport = {
  installed: boolean;
  /** OS of the machine hosting the daemon — NOT the one reading this page.
   *  A phone browsing the tab must be told how to install on the host. */
  platform: NodeJS.Platform;
  /** How to install tailscale here, or `null` when we know no command for
   *  this machine — the doctrine of `installCommandFor`: an honest blank
   *  beats a command that fails for a reason we invented. */
  installCommand: string | null;
  /** `BackendState`: `Running`, `Stopped`, `NeedsLogin`… `null` if unreadable. */
  state: string | null;
  /** This node's name on the tailnet, trailing dot stripped. */
  dnsName: string | null;
  addresses: string[];
  /** `tailscale serve` handlers, empty when nothing is served. */
  serve: ServeHandler[];
  /** What the CLI printed instead of the JSON asked for (exit 0), `null` otherwise. */
  error: string | null;
};

const TAILSCALE_TIMEOUT_MS = 10_000;

/** `tailscale status --json`, tolerant of every way it can fail: an absent
 *  binary, a stopped daemon and a version that changed its output all mean the
 *  same thing to the tab — no tailnet fact to show, and no error to raise. */
function tailscaleJson(bin: string, args: string[]): unknown | null {
  const read = readTailscaleJson(bin, args);
  return read.ok ? read.value : null;
}

/**
 * Same, but tells apart the one failure the tab must show: an exit 0 with a
 * text that is not JSON — the macOS app bundle started as its GUI says so
 * there, and reading it as "not connected" would hide why.
 */
function readTailscaleJson(bin: string, args: string[]): { ok: true; value: unknown } | { ok: false; error: string | null } {
  let r: ExecResult;
  try {
    r = getHost().exec(bin, args, tailscaleCliOpts(bin, { timeout: TAILSCALE_TIMEOUT_MS }));
  } catch {
    return { ok: false, error: null };
  }
  if (r.code !== 0) return { ok: false, error: null };
  try {
    return { ok: true, value: JSON.parse(r.stdout) as unknown };
  } catch {
    return { ok: false, error: unreadableOutput(r.stdout, r.stderr) };
  }
}

/** First line of a CLI answer that should have been JSON, `null` when it said nothing. */
export function unreadableOutput(stdout: string, stderr: string): string | null {
  const line = `${stdout}\n${stderr}`.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 200) : null;
}

export function parseTailscaleStatus(payload: unknown): Pick<TailscaleReport, 'state' | 'dnsName' | 'addresses'> {
  const root = (payload ?? {}) as { BackendState?: unknown; Self?: { DNSName?: unknown; TailscaleIPs?: unknown } };
  const dns = typeof root.Self?.DNSName === 'string' ? root.Self.DNSName.replace(/\.$/, '') : null;
  const ips = Array.isArray(root.Self?.TailscaleIPs)
    ? root.Self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string')
    : [];
  return {
    state: typeof root.BackendState === 'string' ? root.BackendState : null,
    dnsName: dns && dns.length > 0 ? dns : null,
    addresses: ips,
  };
}

export function parseTailscaleServe(payload: unknown): ServeHandler[] {
  const web = (payload as { Web?: Record<string, { Handlers?: Record<string, unknown> }> } | null)?.Web;
  if (!web || typeof web !== 'object') return [];
  const rows: ServeHandler[] = [];
  for (const [host, entry] of Object.entries(web)) {
    for (const [path, handler] of Object.entries(entry?.Handlers ?? {})) {
      const h = (handler ?? {}) as { Proxy?: unknown; Path?: unknown; Text?: unknown };
      const target = typeof h.Proxy === 'string'
        ? h.Proxy
        : typeof h.Path === 'string'
          ? h.Path
          : typeof h.Text === 'string'
            ? 'text'
            : 'unknown';
      rows.push({ host: path === '/' ? host : `${host}${path}`, target });
    }
  }
  return rows;
}

/** The two facts `installCommandFor` needs, read on the daemon's machine —
 *  the same pair `diagnose()` builds, and for the same reason: the install
 *  command depends on the distribution, not on the browser asking. */
export function hostMachine(): Machine {
  const linux = process.platform === 'linux' ? linuxRelease(readOsRelease()) : null;
  return { platform: process.platform, packageManager: linux?.packageManager ?? null };
}

function tailscaleReport(): TailscaleReport {
  const base = { platform: process.platform, installCommand: installCommandFor('tailscale', hostMachine()) };
  const { path } = whichBin('tailscale', config().host.binaries);
  if (!path) return { installed: false, ...base, state: null, dnsName: null, addresses: [], serve: [], error: null };
  const read = readTailscaleJson(path, ['status', '--json']);
  const status = parseTailscaleStatus(read.ok ? read.value : null);
  return {
    installed: true,
    ...base,
    ...status,
    error: read.ok ? null : read.error,
    // Only ask once the backend is up: on a stopped tailscaled this call
    // blocks until its own timeout for an answer we already know is empty.
    serve: status.state === 'Running' ? parseTailscaleServe(tailscaleJson(path, ['serve', 'status', '--json'])) : [],
  };
}

export type WebUiAccessReport = {
  app: {
    /**
     * `config.app.enabled` — the daemon runs the web server itself. When
     * false, something else serves the UI (Compose behind Traefik, a reverse
     * proxy) and `host`/`port` below are only what the config ASKS for: the
     * origin the browser is already on is then the reliable witness.
     */
    servedByDaemon: boolean;
    host: string;
    port: number;
    loopbackOnly: boolean;
    publicUrl: string;
  };
  addresses: NetworkAddress[];
  tailscale: TailscaleReport;
  /** Posture, read off the config. Each key stays editable in its own native
   *  settings group — this tab never duplicates a writable row. */
  security: {
    daemon: {
      host: string;
      port: number;
      loopbackOnly: boolean;
      auth: 'auto' | 'required' | 'off';
      /** What the middleware enforces: an exposed WebUI or a TLS proxy counts too. */
      authEnforced: boolean;
    };
    behindTlsProxy: boolean;
    trustedProxies: string[];
    /** Zero accounts = anonymous first run, nothing to authenticate against. */
    users: number;
  };
};

export function webUiAccess(): WebUiAccessReport {
  const cfg = config();
  const daemonLoopback = isLoopbackHost(cfg.daemon.listen.host);
  return {
    app: {
      servedByDaemon: cfg.app.enabled,
      host: cfg.app.listen.host,
      port: cfg.app.listen.port,
      loopbackOnly: isLoopbackHost(cfg.app.listen.host),
      publicUrl: cfg.app.publicUrl,
    },
    addresses: hostAddresses(),
    tailscale: tailscaleReport(),
    security: {
      daemon: {
        host: cfg.daemon.listen.host,
        port: cfg.daemon.listen.port,
        loopbackOnly: daemonLoopback,
        auth: cfg.daemon.auth,
        authEnforced: authIsRequired(cfg),
      },
      behindTlsProxy: cfg.daemon.behindTlsProxy,
      trustedProxies: cfg.daemon.trustedProxies,
      users: dbApi.countUsers(),
    },
  };
}
