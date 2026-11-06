/**
 * SSRF guard for destinations a USER typed, not the operator.
 *
 * `pluginPolicy.http.allow` is written by whoever runs the daemon; a URL in a
 * plugin connection comes from a form in the browser. Once approved it opens
 * `ctx.fetch`, so this module decides which addresses such a URL may reach:
 *
 *  - never: link-local (cloud metadata lives there), the known metadata
 *    addresses outside it, multicast, unspecified and reserved ranges;
 *  - loopback, private and Tailscale ranges only when the connection declares
 *    `allowPrivateNetwork` — a box on the LAN is a legitimate target, but the
 *    user has to say so and the approver sees it;
 *  - plain `http:` only towards loopback or Tailscale, where the transport is
 *    already private; anything else must be HTTPS.
 *
 * The check runs on the RESOLVED addresses, at every request and every
 * redirect, and the socket connects to the address that was checked: the
 * lookup handed to `http.request` returns the validated answer instead of
 * asking DNS a second time (DNS rebinding between check and connect).
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/** A destination refused by the guard. The message never carries a credential. */
export class DestinationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationRefusedError';
  }
}

export type DestinationPolicy = {
  readonly allowPrivateNetwork: boolean;
  /** Plain `http:` towards any admitted address, not only loopback and Tailscale. */
  readonly allowPlainHttp?: boolean;
};
export type AddressKind = 'blocked' | 'loopback' | 'tailscale' | 'private' | 'public';
export type ResolvedAddress = { address: string; family: 4 | 6 };
export type AddressLookup = (hostname: string) => Promise<ResolvedAddress[]>;

type Range = { base: bigint; bits: number; kind: AddressKind };

function v4ToBigInt(address: string): bigint | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
}

function v6ToBigInt(raw: string): bigint | undefined {
  let address = raw.split('%')[0]!.toLowerCase();
  // An embedded dotted quad (`::ffff:1.2.3.4`) becomes two hex groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted) {
    const v4 = v4ToBigInt(dotted[1]!);
    if (v4 === undefined) return undefined;
    address = `${address.slice(0, -dotted[1]!.length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

const v4 = (cidr: string, kind: AddressKind): Range => {
  const [base, bits] = cidr.split('/');
  return { base: v4ToBigInt(base!)!, bits: Number(bits), kind };
};
const v6 = (cidr: string, kind: AddressKind): Range => {
  const [base, bits] = cidr.split('/');
  return { base: v6ToBigInt(base!)!, bits: Number(bits), kind };
};

// First match wins: the specific metadata addresses come before the broad
// ranges that would otherwise admit them (100.100.100.200 is inside 100.64/10).
const V4_RANGES: readonly Range[] = [
  v4('100.100.100.200/32', 'blocked'), // Alibaba Cloud metadata
  v4('0.0.0.0/8', 'blocked'),
  v4('169.254.0.0/16', 'blocked'), // link-local: AWS/GCP/Azure/OCI metadata
  v4('192.0.0.0/24', 'blocked'),
  v4('224.0.0.0/4', 'blocked'), // multicast
  v4('240.0.0.0/4', 'blocked'), // reserved + broadcast
  v4('127.0.0.0/8', 'loopback'),
  v4('100.64.0.0/10', 'tailscale'),
  v4('10.0.0.0/8', 'private'),
  v4('172.16.0.0/12', 'private'),
  v4('192.168.0.0/16', 'private'),
  v4('198.18.0.0/15', 'private'),
];
const V6_RANGES: readonly Range[] = [
  v6('fd00:ec2::254/128', 'blocked'), // AWS metadata over IPv6
  v6('::/128', 'blocked'),
  v6('fe80::/10', 'blocked'),
  v6('fec0::/10', 'blocked'),
  v6('ff00::/8', 'blocked'),
  v6('::1/128', 'loopback'),
  v6('fd7a:115c:a1e0::/48', 'tailscale'),
  v6('fc00::/7', 'private'),
];

function inRange(value: bigint, range: Range, width: number): boolean {
  const shift = BigInt(width - range.bits);
  return (value >> shift) === (range.base >> shift);
}

/** What an IP literal is, IPv4 forms embedded in IPv6 included. */
export function classifyAddress(address: string): AddressKind {
  const family = isIP(address.split('%')[0]!);
  if (family === 4) {
    const value = v4ToBigInt(address)!;
    return V4_RANGES.find((range) => inRange(value, range, 32))?.kind ?? 'public';
  }
  if (family !== 6) return 'blocked';
  const value = v6ToBigInt(address);
  if (value === undefined) return 'blocked';
  const embedded = (offset: bigint) => {
    const inner = (value >> offset) & 0xffffffffn;
    return classifyAddress([24n, 16n, 8n, 0n].map((s) => String((inner >> s) & 0xffn)).join('.'));
  };
  // Mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) all
  // reach an IPv4 host: judge that host, not the wrapper.
  if (value >> 32n === 0xffffn) return embedded(0n);
  if (value >> 32n === 0x64ff9b0000000000000000n) return embedded(0n);
  if (value >> 112n === 0x2002n) return embedded(80n);
  // Deprecated IPv4-compatible form (::a.b.c.d), except :: and ::1 themselves.
  if (value >> 32n === 0n && value > 1n) return embedded(0n);
  return V6_RANGES.find((range) => inRange(value, range, 128))?.kind ?? 'public';
}

/** Throws unless `address` may be reached under `policy`. */
export function assertAddressAllowed(address: string, policy: DestinationPolicy): AddressKind {
  const kind = classifyAddress(address);
  if (kind === 'blocked') throw new DestinationRefusedError(`address ${address} is never reachable (link-local, metadata, multicast or reserved)`);
  if (kind !== 'public' && !policy.allowPrivateNetwork) {
    throw new DestinationRefusedError(`address ${address} is ${kind}; the connection must declare private network access`);
  }
  return kind;
}

/** Shape checks that do not need DNS: scheme, no credentials in the URL. */
export function assertUrlShape(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DestinationRefusedError(`scheme ${url.protocol} refused`);
  if (url.username || url.password) throw new DestinationRefusedError('credentials in the URL are refused');
  if (!url.hostname) throw new DestinationRefusedError('missing host');
}

const defaultLookup: AddressLookup = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
};

/**
 * Resolve and judge a URL. EVERY answer must pass: a name that resolves to a
 * public and a metadata address must not let the socket pick the bad one.
 */
export async function resolveDestination(url: URL, policy: DestinationPolicy, lookup: AddressLookup = defaultLookup): Promise<ResolvedAddress[]> {
  assertUrlShape(url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  let addresses: ResolvedAddress[];
  if (literal) addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  else {
    try { addresses = await lookup(host); }
    catch (error) {
      // A lookup that judges its own answers says why; any other failure is a name that does not resolve.
      if (error instanceof DestinationRefusedError) throw error;
      throw new DestinationRefusedError(`host ${host} does not resolve`);
    }
    if (addresses.length === 0) throw new DestinationRefusedError(`host ${host} does not resolve`);
  }
  const kinds = addresses.map((entry) => assertAddressAllowed(entry.address, policy));
  if (url.protocol === 'http:' && !policy.allowPlainHttp && !kinds.every((kind) => kind === 'loopback' || kind === 'tailscale')) {
    throw new DestinationRefusedError('HTTPS is required outside loopback and Tailscale addresses');
  }
  return addresses;
}

export type GuardedFetchOptions = {
  /**
   * Policy for a URL, or a throw when it is not an allowed destination at
   * all. Called for the first URL and again for every redirect target.
   */
  destination(url: URL): DestinationPolicy;
  lookup?: AddressLookup;
  maxRedirects?: number;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 204, 205, 304]);
// Undici's own body/headers timeout: an idle socket is not kept forever.
const IDLE_MS = 300_000;

function send(url: URL, addresses: ResolvedAddress[], method: string, headers: Headers, body: Buffer | undefined, signal: AbortSignal): Promise<IncomingMessage> {
  const pinned: LookupFunction = (_hostname, options, callback) => {
    const wanted = typeof options === 'object' && options?.family ? options.family : 0;
    const pool = addresses.filter((entry) => !wanted || entry.family === wanted);
    const list = pool.length ? pool : addresses;
    // Answer on a later turn, like DNS: a synchronous answer lets a connect that fails at once (EHOSTUNREACH)
    // emit its socket 'error' before ClientRequest listens, and that uncaught error kills the daemon.
    setImmediate(() => {
      if (typeof options === 'object' && options?.all) (callback as (e: null, a: ResolvedAddress[]) => void)(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
  const flat: Record<string, string> = {};
  headers.forEach((value, key) => { flat[key] = value; });
  if (!headers.has('accept-encoding')) flat['accept-encoding'] = 'gzip, deflate, br';
  if (body) flat['content-length'] = String(body.byteLength);
  const options: RequestOptions = {
    method, headers: flat, signal, agent: false, lookup: pinned,
    host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
  };
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options, resolve);
    request.setTimeout(IDLE_MS, () => request.destroy(new Error('Request idle timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

function toResponse(incoming: IncomingMessage, url: URL, method: string, redirected: boolean): Response {
  const headers = new Headers();
  for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
  const status = incoming.statusCode ?? 502;
  let stream: Readable = incoming;
  const encoding = (headers.get('content-encoding') ?? '').trim().toLowerCase();
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
    : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
  const empty = method === 'HEAD' || NULL_BODY.has(status);
  if (decoder && !empty) {
    incoming.on('error', (error) => decoder.destroy(error));
    stream = incoming.pipe(decoder);
    headers.delete('content-encoding');
    headers.delete('content-length');
  }
  if (empty) incoming.resume();
  const response = new Response(empty ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status, statusText: incoming.statusMessage ?? '', headers,
  });
  Object.defineProperty(response, 'url', { value: url.href });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
}

/**
 * `fetch` through the guard. Same inputs and same `Response` as the global
 * one; redirects are followed by hand so each hop is judged again.
 */
export async function guardedFetch(input: Parameters<typeof globalThis.fetch>[0], init: Parameters<typeof globalThis.fetch>[1], options: GuardedFetchOptions): Promise<Response> {
  const request = new Request(input, init);
  let url = new URL(request.url);
  let method = request.method;
  const headers = new Headers(request.headers);
  let body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const max = options.maxRedirects ?? 5;
  for (let hop = 0; ; hop++) {
    const policy = options.destination(url);
    const addresses = await resolveDestination(url, policy, options.lookup);
    request.signal.throwIfAborted();
    const incoming = await send(url, addresses, method, headers, body, request.signal);
    const status = incoming.statusCode ?? 0;
    const location = incoming.headers.location;
    if (!REDIRECTS.has(status) || !location || request.redirect === 'manual') return toResponse(incoming, url, method, hop > 0);
    incoming.resume();
    if (request.redirect === 'error') throw new TypeError('fetch failed: redirect refused by redirect mode');
    if (hop >= max) throw new DestinationRefusedError('too many redirects');
    const next = new URL(location, url);
    if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
      method = method === 'HEAD' ? 'HEAD' : 'GET';
      body = undefined;
      for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
    }
    // Credentials meant for one origin do not travel to another.
    if (next.origin !== url.origin) for (const name of ['authorization', 'proxy-authorization', 'cookie']) headers.delete(name);
    url = next;
  }
}
