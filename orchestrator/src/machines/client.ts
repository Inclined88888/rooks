/**
 * The one way this daemon calls another machine of the fleet.
 *
 * `fetch` is not used: it cannot vet the address a name resolves to at
 * connect time, and it follows redirects unless told otherwise. Here:
 *
 *  - the URL has already passed `parseMachineUrl`; the address the socket
 *    really connects to is vetted again in `lookup` (`resolvedAddressAllowed`),
 *    so DNS cannot answer one thing to a check and another to the connection;
 *  - TLS is verified against the system's certificate authorities when the
 *    runtime exposes them (`tls.getCACertificates`, Node ≥ 22.15), Node's
 *    bundled ones otherwise. No pinning in v1 (the maintainer's arbitration);
 *  - a redirect is never followed: it is an error;
 *  - the answer is capped in size and time;
 *  - a token travels in `Authorization` only, and no error message carries it.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import * as tls from 'node:tls';
import { rooksVersion } from '../data-version.js';
import { parseMachineUrl, resolvedAddressAllowed } from './url.js';

export const MACHINE_TIMEOUT_MS = 10_000;
export const MACHINE_MAX_BYTES = 256 * 1024;

export type MachineRequestErrorCode =
  | 'invalid_url'
  | 'blocked_address'
  | 'unreachable'
  | 'timeout'
  | 'tls_error'
  | 'redirect'
  | 'too_large';

export class MachineRequestError extends Error {
  constructor(readonly code: MachineRequestErrorCode, message: string) {
    super(message);
    this.name = 'MachineRequestError';
  }
}

export type MachineResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  /** Parsed body when the machine answered JSON, `null` otherwise. */
  json: unknown;
};

/** Every address a name resolves to. The socket may try any of them. */
export type MachineResolver = (
  hostname: string,
  family: number | undefined,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export type MachineRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  /** Absolute path on the machine, `/api/...`. */
  path: string;
  token?: string;
  body?: unknown;
  timeoutMs?: number;
  /** Test seam: answers DNS in place of the system resolver. */
  resolver?: MachineResolver;
};

let caCache: string[] | null | undefined;

/** System CAs plus Node's defaults, or `null` to keep the runtime's own list. */
function trustedCas(): string[] | null {
  if (caCache !== undefined) return caCache;
  const read = (tls as { getCACertificates?: (kind: string) => string[] }).getCACertificates;
  if (typeof read !== 'function') return (caCache = null);
  try {
    caCache = [...new Set([...read('default'), ...read('system')])];
  } catch {
    caCache = null;
  }
  return caCache;
}

const systemResolver: MachineResolver = (hostname, family, callback) => {
  dnsLookup(hostname, { all: true, ...(family ? { family } : {}) }, callback);
};

function vettedLookup(urlIsLoopback: boolean, resolver: MachineResolver): LookupFunction {
  return (hostname, options, callback) => {
    const family = typeof options.family === 'number' && options.family !== 0 ? options.family : undefined;
    resolver(hostname, family, (err, addresses) => {
      if (err) {
        callback(err, '', 0);
        return;
      }
      // Every answer must be acceptable: the socket may try any of them.
      const refused = addresses.length === 0 || addresses.some((entry) => !resolvedAddressAllowed(entry.address, urlIsLoopback));
      if (refused) {
        callback(Object.assign(new Error('address refused'), { code: 'EROOKS_BLOCKED' }), '', 0);
        return;
      }
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (e: null, list: LookupAddress[]) => void)(null, addresses);
        return;
      }
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}

export function classifyMachineError(err: NodeJS.ErrnoException): MachineRequestError {
  const code = err.code ?? '';
  if (code === 'EROOKS_BLOCKED') return new MachineRequestError('blocked_address', 'this address cannot be a machine of the fleet');
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code.includes('CERT') || code === 'EPROTO'
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new MachineRequestError('tls_error', 'the machine did not present a certificate this daemon trusts');
  }
  return new MachineRequestError('unreachable', 'the machine could not be reached');
}

type Outgoing = { secure: boolean; options: RequestOptions & tls.ConnectionOptions };

/**
 * The socket options of one call to a machine: vetted lookup, trusted CAs,
 * no pooling (`agent: false`), the token in `Authorization` only. Throws a
 * `MachineRequestError` for a URL the policy refuses.
 */
export function machineConnectOptions(
  base: string,
  call: { method: string; path: string; token?: string; headers?: Record<string, string>; resolver?: MachineResolver },
): Outgoing {
  const parsed = parseMachineUrl(base);
  if (!parsed.ok) throw new MachineRequestError(parsed.problem === 'blocked_address' ? 'blocked_address' : 'invalid_url', 'invalid machine URL');
  const target = new URL(`${parsed.value.url}${call.path}`);
  const headers: Record<string, string> = {
    'user-agent': `Rooks/${rooksVersion()} (machines)`,
    ...call.headers,
  };
  if (call.token) headers.authorization = `Bearer ${call.token}`;
  const secure = target.protocol === 'https:';
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const options: RequestOptions & tls.ConnectionOptions = {
    method: call.method,
    hostname: host,
    port: target.port ? Number(target.port) : (secure ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    headers,
    lookup: vettedLookup(parsed.value.loopback, call.resolver ?? systemResolver),
    agent: false,
  };
  if (secure) {
    const ca = trustedCas();
    if (ca) options.ca = ca;
    // SNI carries a host NAME: an IP literal there is refused by RFC 6066 and
    // warned about by Node (DEP0123). The certificate is still checked against it.
    if (isIP(host) === 0) options.servername = host;
  }
  return { secure, options };
}

/** Call `<base><path>` on a machine. `base` is a stored, already-vetted URL. */
export function machineRequest(base: string, req: MachineRequest): Promise<MachineResponse> {
  const body = req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body), 'utf8');
  const extra: Record<string, string> = { accept: 'application/json' };
  if (body) {
    extra['content-type'] = 'application/json';
    extra['content-length'] = String(body.length);
  }
  let outgoingOptions: Outgoing;
  try {
    outgoingOptions = machineConnectOptions(base, { method: req.method, path: req.path, token: req.token, headers: extra, resolver: req.resolver });
  } catch (err) {
    return Promise.reject(err);
  }
  const { secure, options } = outgoingOptions;
  const timeoutMs = req.timeoutMs ?? MACHINE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: MachineRequestError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outgoing.destroy();
      reject(error);
    };
    const outgoing = (secure ? httpsRequest : httpRequest)(options, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        fail(new MachineRequestError('redirect', 'the machine answered with a redirect'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MACHINE_MAX_BYTES) {
          fail(new MachineRequestError('too_large', 'the machine answered more than expected'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (err) => fail(classifyMachineError(err)));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        if (/\bjson\b/i.test(String(res.headers['content-type'] ?? '')) && text) {
          try {
            json = JSON.parse(text) as unknown;
          } catch {
            json = null;
          }
        }
        resolve({ status, headers: res.headers, json });
      });
    });
    const timer = setTimeout(() => fail(new MachineRequestError('timeout', 'the machine did not answer in time')), timeoutMs);
    outgoing.on('error', (err: NodeJS.ErrnoException) => fail(classifyMachineError(err)));
    outgoing.end(body);
  });
}
