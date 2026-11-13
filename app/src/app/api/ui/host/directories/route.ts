import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The folders of the ACTIVE machine's disk, one level (TIM-0136): a folder
 *  picker on a remote machine, or in a browser, cannot use this computer's
 *  dialog. The daemon checks the session and builds every path itself; only
 *  `path` and `files` (file mode, TODO #791 — the daemon validates it) travel,
 *  nothing else the page sends. */
export async function GET(request: Request): Promise<Response> {
  const incoming = new URL(request.url).searchParams;
  const parts: string[] = [];
  const path = incoming.get('path');
  if (path) parts.push(`path=${encodeURIComponent(path)}`);
  const files = incoming.get('files');
  if (files !== null) parts.push(`files=${encodeURIComponent(files)}`);
  return proxyJson('GET', `/api/host/directories${parts.length ? `?${parts.join('&')}` : ''}`);
}
