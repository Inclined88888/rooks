/**
 * Client-side reading of `GET /api/ui/webui-access` — types, plus the two
 * derivations the `WebUI` settings tab needs and nothing more.
 *
 * The facts themselves come from the daemon (`orchestrator/src/web-access.ts`):
 * this page often runs in the `rooks-app` container, which sees the Docker
 * bridge and no `tailscale` binary.
 */

export type NetworkAddress = {
  iface: string;
  address: string;
  family: 'ipv4' | 'ipv6';
};

export type ServeHandler = { host: string; target: string };

export type TailscaleReport = {
  installed: boolean;
  /** `process.platform` of the machine hosting the daemon, not the one
   *  reading this page. A plain string: the daemon may run on a platform this
   *  build has never heard of, and the tab only ever compares it. */
  platform: string;
  /** How to install tailscale on that machine, `null` when unknown. */
  installCommand: string | null;
  state: string | null;
  dnsName: string | null;
  addresses: string[];
  serve: ServeHandler[];
  /** What the CLI printed instead of its JSON (exit 0); absent from an older daemon. */
  error?: string | null;
};

export type WebUiAccessReport = {
  app: {
    servedByDaemon: boolean;
    host: string;
    port: number;
    loopbackOnly: boolean;
    publicUrl: string;
  };
  addresses: NetworkAddress[];
  tailscale: TailscaleReport;
  security: {
    daemon: {
      host: string;
      port: number;
      loopbackOnly: boolean;
      auth: 'auto' | 'required' | 'off';
      authEnforced: boolean;
    };
    behindTlsProxy: boolean;
    trustedProxies: string[];
    users: number;
  };
};

/** The tailnet URL `tailscale serve --https=443` publishes for this node. */
export function tailnetUrl(dnsName: string | null): string | null {
  return dnsName ? `https://${dnsName}` : null;
}

/**
 * Whether an origin is a secure context — the browser rule that decides
 * whether the PWA can be installed and the service worker can register.
 *
 * This is what ties the two halves of the tab together: `http://rooks.localhost`
 * qualifies through the localhost exception, a bare LAN IP over plain HTTP does
 * not. So `tailscale serve --https=443` is not merely convenient, it is what
 * makes Rooks installable from a phone.
 *
 * Deliberately not read off `window.isSecureContext`: the tab must also be able
 * to say what WOULD happen at another address than the current one.
 */
export function isSecureOrigin(href: string | null | undefined): boolean {
  if (!href) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
  // Electron serves the packaged UI from its own scheme, which the engine
  // registers as privileged — same posture as https.
  if (url.protocol === 'app:' || url.protocol === 'file:') return true;
  if (url.protocol !== 'http:' && url.protocol !== 'ws:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // The localhost exception, as the browsers implement it: the name itself,
  // anything under `.localhost`, and the loopback addresses.
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '::1'
    || host === '127.0.0.1'
    || host.startsWith('127.');
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The address another computer pairs with this one (Machines): a
 * `tailscale serve` handler at the root of a tailnet vhost that forwards to
 * THIS daemon on the loopback. Not `app.publicUrl`, which is the web
 * interface's — pairing against it answers "code refused". `null` when no
 * such handler exists (or the report is not one): the screen links the docs.
 */
export function pairingAddress(report: unknown): string | null {
  const facts = report as Partial<WebUiAccessReport> | null;
  const port = facts?.security?.daemon?.port;
  const serve = facts?.tailscale?.serve;
  if (typeof port !== 'number' || !Array.isArray(serve)) return null;
  for (const handler of serve) {
    if (typeof handler?.host !== 'string' || typeof handler.target !== 'string' || handler.host.includes('/')) continue;
    let target: URL;
    let vhost: URL;
    try {
      target = new URL(handler.target);
      vhost = new URL(`https://${handler.host}`);
    } catch {
      continue;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;
    if (!LOOPBACK_HOSTS.has(target.hostname) || target.port !== String(port)) continue;
    // `origin` drops a `:443` the serve status spells out.
    return vhost.origin;
  }
  return null;
}
