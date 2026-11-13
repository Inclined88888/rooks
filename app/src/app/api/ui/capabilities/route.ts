import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 1:1 proxy: what the install can do (active modules, host capabilities,
 *  edition, hidden zones). The front end uses it to hide what does not exist
 *  rather than show dead buttons. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/capabilities');
}
