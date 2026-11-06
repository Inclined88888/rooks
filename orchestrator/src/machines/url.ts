/**
 * What URL a machine of the fleet may have (multi-machine P2c, TODO #329).
 *
 * The URL is typed by a person and called by THIS daemon, server side, with a
 * device token: it is an SSRF surface. The rules, all enforced here:
 *
 *  - HTTPS, without exception for a remote machine (the maintainer's arbitration). Plain
 *    HTTP only when the host is the loopback itself (`localhost`, `127.x`,
 *    `::1`): another daemon on this very computer.
 *  - No credentials, query string nor fragment in the URL: a secret there
 *    leaks into logs and the URL is shown back in the interface.
 *  - Addresses that are never a Timon daemon are refused, whether written
 *    literally or reached through DNS: link-local (cloud metadata endpoints
 *    live there), unspecified, multicast, broadcast and reserved ranges.
 *    A name that resolves to the loopback is refused too: only a URL that SAYS
 *    loopback may reach it (no DNS rebinding onto this host).
 *
 * Private ranges (RFC 1918, the tailnet's CGNAT range, IPv6 ULA) stay allowed:
 * a home server behind a LAN reverse proxy or `tailscale serve` is the very
 * use case. HTTPS with a certificate valid for the name is what keeps a
 * request from landing on an arbitrary internal service.
 */
import { isIP } from 'node:net';

export const MACHINE_URL_MAX = 2048;

export type MachineUrlProblem =
  | 'invalid_url'
  | 'https_required'
  | 'credentials_in_url'
  | 'query_in_url'
  | 'blocked_address';

export type ParsedMachineUrl = {
  /** `https://host[:port][/prefix]`, no trailing slash: paths are appended to it. */
  url: string;
  /** The host is the loopback, written as such. */
  loopback: boolean;
};

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function ipv4Parts(address: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return null;
  const parts = match.slice(1).map(Number) as [number, number, number, number];
  return parts.every((part) => part <= 255) ? parts : null;
}

/** The IPv4 an IPv6 address carries (`::ffff:a.b.c.d`, NAT64 `64:ff9b::a.b.c.d`), if any. */
function embeddedIpv4(address: string): string | null {
  const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1]!;
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isLoopbackAddress(address: string): boolean {
  const host = bareHost(address);
  const v4 = embeddedIpv4(host) ?? host;
  const parts = ipv4Parts(v4);
  if (parts) return parts[0] === 127;
  return host === '::1';
}

/**
 * Addresses no daemon of the fleet lives at. The loopback is NOT in this
 * list: whether it is allowed depends on how the URL named it.
 */
export function isBlockedAddress(address: string): boolean {
  const host = bareHost(address);
  const v4 = embeddedIpv4(host) ?? host;
  const parts = ipv4Parts(v4);
  if (parts) {
    const [a, b] = parts;
    if (a === 0) return true; // "this network", 0.0.0.0
    if (a === 169 && b === 254) return true; // link-local, cloud metadata (169.254.169.254)
    if (a >= 224) return true; // multicast, reserved, broadcast
    if (v4 === '100.100.100.200') return true; // a cloud metadata endpoint outside link-local
    return false;
  }
  if (isIP(host) !== 6) return true; // not an address at all
  if (host === '::') return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
  if (host.startsWith('ff')) return true; // multicast
  if (host === 'fd00:ec2::254') return true; // cloud metadata over IPv6
  return false;
}

function hostIsLoopbackName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || (isIP(host) !== 0 && isLoopbackAddress(host));
}

export function parseMachineUrl(raw: unknown): { ok: true; value: ParsedMachineUrl } | { ok: false; problem: MachineUrlProblem } {
  if (typeof raw !== 'string') return { ok: false, problem: 'invalid_url' };
  const text = raw.trim();
  if (!text || text.length > MACHINE_URL_MAX) return { ok: false, problem: 'invalid_url' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, problem: 'invalid_url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, problem: 'invalid_url' };
  if (url.username || url.password) return { ok: false, problem: 'credentials_in_url' };
  // `new URL` drops an empty `?` / `#`; a typed one is still a sign of a pasted page URL.
  if (url.search || url.hash || /[?#]/.test(text)) return { ok: false, problem: 'query_in_url' };
  const host = bareHost(url.hostname);
  if (!host) return { ok: false, problem: 'invalid_url' };
  const loopback = hostIsLoopbackName(host);
  if (url.protocol === 'http:' && !loopback) return { ok: false, problem: 'https_required' };
  if (isIP(host) !== 0 && !loopback && isBlockedAddress(host)) return { ok: false, problem: 'blocked_address' };
  const prefix = url.pathname.replace(/\/+$/, '');
  return { ok: true, value: { url: `${url.protocol}//${url.host}${prefix}`, loopback } };
}

/**
 * Whether a resolved address may be connected to for a URL whose host was (or
 * was not) the loopback by name. Checked at connect time, on the address the
 * socket really uses, so DNS cannot answer one thing to the check and another
 * to the connection.
 */
export function resolvedAddressAllowed(address: string, urlIsLoopback: boolean): boolean {
  if (isLoopbackAddress(address)) return urlIsLoopback;
  if (urlIsLoopback) return false; // `localhost` that resolves off the host
  return !isBlockedAddress(address);
}
