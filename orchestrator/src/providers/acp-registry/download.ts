/**
 * Downloading a program the daemon is going to launch.
 *
 * https only, a bounded number of redirects (release assets live behind one),
 * a size ceiling enforced WHILE streaming, and the sha256 computed on the way
 * with `node:crypto` (rule 12: no dependency). When the registry published a
 * hash the download is refused on mismatch and the file is deleted; when it did
 * not, the hash is still computed and recorded — the caller decides whether the
 * person agreed to an unverified download.
 */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export class DownloadError extends Error {
  constructor(readonly code: 'insecure' | 'redirects' | 'http' | 'too-large' | 'checksum' | 'network', message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

export type Fetcher = (url: string, init: { redirect: 'manual'; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export type DownloadOptions = {
  fetchFn?: Fetcher;
  maxBytes: number;
  /** Lowercase or uppercase hex; absent = the registry gave none. */
  expectedSha256?: string;
  maxRedirects?: number;
  timeoutMs?: number;
};

function assertHttps(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new DownloadError('insecure', 'invalid download address'); }
  if (parsed.protocol !== 'https:') throw new DownloadError('insecure', 'downloads must be served over https');
  return parsed;
}

export async function downloadVerified(
  url: string,
  dest: string,
  opts: DownloadOptions,
): Promise<{ sha256: string; bytes: number }> {
  const fetchFn: Fetcher = opts.fetchFn ?? ((u, init) => fetch(u, init));
  const maxRedirects = opts.maxRedirects ?? 5;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 15 * 60_000);
  timer.unref();
  let fd: number | null = null;
  try {
    let current = assertHttps(url).href;
    let response: Response | null = null;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      let res: Response;
      try {
        res = await fetchFn(current, { redirect: 'manual', signal: abort.signal });
      } catch (err) {
        throw new DownloadError('network', `download failed: ${(err as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new DownloadError('http', `unexpected redirect (${res.status}) without a destination`);
        current = assertHttps(new URL(location, current).href).href;
        void res.body?.cancel();
        continue;
      }
      response = res;
      break;
    }
    if (!response) throw new DownloadError('redirects', 'too many redirects');
    if (!response.ok || !response.body) throw new DownloadError('http', `download refused (HTTP ${response.status})`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      void response.body.cancel();
      throw new DownloadError('too-large', 'the download is larger than the allowed size');
    }

    mkdirSync(dirname(dest), { recursive: true });
    fd = openSync(dest, 'w', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > opts.maxBytes) {
        void reader.cancel();
        throw new DownloadError('too-large', 'the download is larger than the allowed size');
      }
      hash.update(value);
      writeSync(fd, value);
    }
    closeSync(fd);
    fd = null;
    const sha256 = hash.digest('hex');
    if (opts.expectedSha256 && opts.expectedSha256.toLowerCase() !== sha256) {
      throw new DownloadError('checksum', 'the downloaded file does not match the published sha256 — refused');
    }
    return { sha256, bytes };
  } catch (err) {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    rmSync(dest, { force: true });
    if (err instanceof DownloadError) throw err;
    throw new DownloadError('network', `download failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
