import { relayFetch, resolveTarget } from '../machines/target';
import { sessionProxyHeaders } from './proxy';

type Chunk = { data: string; offset: number; size: number; name: string; mimeType: string; eof: boolean };

/** Stream into the client's download manager without exposing host paths or buffering the whole file. */
export async function streamBrowserDownload(req: Request, profileId: string, downloadId: string): Promise<Response> {
  const clientId = new URL(req.url).searchParams.get('clientId');
  const headers = { ...sessionProxyHeaders(), 'content-type': 'application/json' };
  // The profile lives on the daemon of the active machine; resolved once, so
  // every chunk of one download is read from the same place.
  const target = await resolveTarget(req);
  const abort = new AbortController();
  req.signal.addEventListener('abort', () => abort.abort(), { once: true });
  let offset = 0;
  async function read(): Promise<Chunk> {
    const response = await relayFetch(target, `/api/native-browser/${encodeURIComponent(profileId)}/command`, {
      method: 'POST', cache: 'no-store', headers, signal: abort.signal,
      body: JSON.stringify({ action: 'downloadRead', downloadId, offset, length: 128 * 1024, clientId }),
    }, { incoming: req.headers });
    if (!response.ok) throw Object.assign(new Error((await response.json().catch(() => ({}))).error || 'Download unavailable'), { status: response.status });
    return ((await response.json()) as { result: Chunk }).result;
  }
  let first: Chunk;
  try { first = await read(); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as { status?: number }).status ?? 502 }); }
  let pending: Chunk | null = first;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = pending ?? await read(); pending = null;
        const bytes = Buffer.from(chunk.data, 'base64');
        if (!bytes.length && !chunk.eof) throw new Error('Download did not advance');
        offset += bytes.length;
        if (bytes.length) controller.enqueue(bytes);
        if (chunk.eof) controller.close();
      } catch (error) { abort.abort(); controller.error(error); }
    },
    cancel() { abort.abort(); },
  });
  const name = first.name.replace(/[\r\n\x00-\x1f]/g, '').slice(0, 255) || 'download';
  return new Response(body, { headers: {
    'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
    ...(Number.isSafeInteger(first.size) && first.size >= 0 ? { 'content-length': String(first.size) } : {}),
  } });
}
