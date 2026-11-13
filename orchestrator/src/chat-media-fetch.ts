/**
 * Fetching an agent's external media on the daemon (SUG-0008).
 *
 * The browser never loads a third-party address a message carries: an image
 * URL written by a model is the classic exfiltration channel
 * (`https://attacker/p.png?secret=…`), and it also leaks the reader's IP and
 * `Referer` or pokes the internal network. The daemon fetches instead, keeps
 * the bytes, and the chat shows them from the Rooks origin.
 *
 * That turns the daemon into the one making the request, so this module is an
 * SSRF guard first:
 *  - `https:` only, on a host NAME, default port, no credentials;
 *  - every address the name resolves to must be public — one private address
 *    among public ones refuses the lot — and the connection is pinned to the
 *    address that was checked, so a second resolution cannot swap it
 *    (DNS rebinding);
 *  - each redirect goes through the same checks, a bounded number of times;
 *  - the answer must announce an image or a video AND its bytes must agree;
 *    SVG and HTML are refused; the size is capped while streaming.
 *
 * Nothing here logs or returns the address: it may carry a token.
 */

import { BlockList, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { sniffMedia, type SniffedMedia } from './chat-media.js';

export type MediaFetchCode =
  | 'scheme_refused' | 'credentials_refused' | 'port_refused' | 'host_refused' | 'redirect_refused'
  | 'content_type_refused' | 'not_media' | 'too_large' | 'fetch_failed';

const MESSAGES: Readonly<Record<MediaFetchCode, string>> = {
  scheme_refused: 'only https:// addresses are accepted',
  credentials_refused: 'an address carrying a user name or a password is refused',
  port_refused: 'an address with an explicit port is refused',
  host_refused: 'the host is local, private or not a public name',
  redirect_refused: 'too many redirects',
  content_type_refused: 'the server did not announce an image or a video (SVG is refused)',
  not_media: 'the bytes received are not the image or video that was announced',
  too_large: 'the media is larger than the allowed size',
  fetch_failed: 'the media could not be downloaded',
};

export class MediaFetchError extends Error {
  constructor(readonly code: MediaFetchCode) {
    super(MESSAGES[code]);
  }
}

export const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_REMOTE_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_URL_CHARS = 2048;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;

/** Names no public site carries: they point at this machine or its network. */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.home.arpa', '.corp', '.private'];

/** Special-purpose ranges (RFC 6890 and successors). Anything a daemon has no
 *  business reaching on behalf of a message. */
const FORBIDDEN = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) FORBIDDEN.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  // `::/96` holds `::`, `::1` and the deprecated IPv4-compatible form.
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) FORBIDDEN.addSubnet(net, prefix, 'ipv6');

/** `::ffff:a.b.c.d`, in any spelling, is an IPv4 address: judge it as one. */
function mappedIpv4(ip: string): string | null {
  let host: string;
  try {
    host = new URL(`https://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!m) return null;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isForbiddenAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return FORBIDDEN.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = mappedIpv4(ip);
    if (v4) return FORBIDDEN.check(v4, 'ipv4');
    return FORBIDDEN.check(ip, 'ipv6');
  }
  return true;
}

/** The URL, if its form alone is acceptable. Resolution is checked later. */
export function checkMediaUrl(raw: string | URL): URL {
  const text = typeof raw === 'string' ? raw : raw.href;
  if (text.length > MAX_URL_CHARS || /[\u0000- \u007f\\]/.test(text)) throw new MediaFetchError('scheme_refused');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new MediaFetchError('scheme_refused');
  }
  if (url.protocol !== 'https:') throw new MediaFetchError('scheme_refused');
  if (url.username || url.password) throw new MediaFetchError('credentials_refused');
  if (url.port) throw new MediaFetchError('port_refused');
  const host = url.hostname.toLowerCase();
  // An IP literal — the WHATWG parser already turned `0x7f.1` or `2130706433`
  // into dotted decimal. A site worth showing has a name, and its certificate
  // is for that name.
  if (host.startsWith('[') || isIP(host)) throw new MediaFetchError('host_refused');
  if (!host.includes('.') || host.endsWith('.') || host === 'localhost') throw new MediaFetchError('host_refused');
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new MediaFetchError('host_refused');
  return url;
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type TransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer>;
  /** Releases the connection and whatever of the body was not read. Called
   *  on every exit, success included; must be idempotent. */
  close: () => void;
};

export type FetchDeps = {
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  /** Connects to `address` — never re-resolves `url.hostname`. */
  request?: (url: URL, address: ResolvedAddress, signal: AbortSignal) => Promise<TransportResponse>;
  maxImageBytes?: number;
  maxVideoBytes?: number;
  timeoutMs?: number;
};

function systemResolve(host: string): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function pinnedRequest(url: URL, address: ResolvedAddress, signal: AbortSignal): Promise<TransportResponse> {
  // The socket asks this function for the address: it gets the checked one,
  // whatever the name resolves to by now.
  const lookup = (_host: string, options: LookupOptions, callback: LookupCallback): void => {
    // Answer on a later turn, like DNS: a synchronous answer lets a connect that fails at once (ENETUNREACH)
    // emit its socket 'error' before ClientRequest listens, and that uncaught error kills the daemon.
    setImmediate(() => {
      if (options.all) callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    });
  };
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: url.hostname,
      servername: url.hostname,
      port: 443,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: { accept: 'image/*,video/*', 'user-agent': 'Rooks-media' },
      lookup,
      agent: false,
      signal,
    }, (res) => resolve({
      status: res.statusCode ?? 0,
      headers: res.headers,
      body: res,
      close: () => {
        // Destroying an unread response makes it emit `error`: listened to
        // here, or the daemon would die of an unhandled event.
        res.on('error', () => {});
        res.destroy();
      },
    }));
    req.on('error', reject);
    req.end();
  });
}

const DECLARED: Readonly<Record<string, SniffedMedia['kind']>> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'video/ogg': 'video',
};

function header(res: TransportResponse, name: string): string | undefined {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function checkedAddress(host: string, resolve: NonNullable<FetchDeps['resolve']>): Promise<ResolvedAddress> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new MediaFetchError('fetch_failed');
  }
  if (addresses.length === 0) throw new MediaFetchError('fetch_failed');
  if (addresses.some((a) => isForbiddenAddress(a.address))) throw new MediaFetchError('host_refused');
  return addresses[0]!;
}

export type FetchedMedia = { bytes: Buffer; media: SniffedMedia; host: string };

export async function fetchRemoteMedia(raw: string, deps: FetchDeps = {}): Promise<FetchedMedia> {
  const resolve = deps.resolve ?? systemResolve;
  const request = deps.request ?? pinnedRequest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TIMEOUT_MS);
  // The response in hand. A hostile host answers a redirect or a refusal and
  // keeps the body open: left alone, each call would pin up to four sockets.
  let open: TransportResponse | undefined;
  try {
    let url = checkMediaUrl(raw);
    for (let hop = 0; ; hop++) {
      const address = await checkedAddress(url.hostname, resolve);
      let res: TransportResponse;
      try {
        res = await request(url, address, controller.signal);
      } catch {
        throw new MediaFetchError('fetch_failed');
      }
      open = res;
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = header(res, 'location');
        res.close();
        open = undefined;
        if (hop >= MAX_REDIRECTS) throw new MediaFetchError('redirect_refused');
        if (!location) throw new MediaFetchError('fetch_failed');
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new MediaFetchError('scheme_refused');
        }
        url = checkMediaUrl(next);
        continue;
      }
      if (res.status !== 200) throw new MediaFetchError('fetch_failed');
      const declaredMime = (header(res, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const declared = DECLARED[declaredMime];
      if (!declared) throw new MediaFetchError('content_type_refused');
      const cap = declared === 'video'
        ? deps.maxVideoBytes ?? MAX_REMOTE_VIDEO_BYTES
        : deps.maxImageBytes ?? MAX_REMOTE_IMAGE_BYTES;
      const announced = Number(header(res, 'content-length'));
      if (Number.isFinite(announced) && announced > cap) throw new MediaFetchError('too_large');
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > cap) throw new MediaFetchError('too_large');
          chunks.push(chunk);
        }
      } catch (err) {
        if (err instanceof MediaFetchError) throw err;
        throw new MediaFetchError('fetch_failed');
      }
      const bytes = Buffer.concat(chunks);
      const media = sniffMedia(bytes.subarray(0, 32));
      if (!media || media.kind !== declared) throw new MediaFetchError('not_media');
      // Images must be exactly what was announced; the ISO containers
      // (`video/mp4` and `video/quicktime`) share a signature.
      if (media.kind === 'image' && media.mime !== declaredMime) throw new MediaFetchError('not_media');
      return { bytes, media, host: url.hostname };
    }
  } finally {
    clearTimeout(timer);
    open?.close();
    // Whatever the transport still holds — a request in flight, a socket —
    // is released; the result, if any, is already in hand.
    controller.abort();
  }
}
