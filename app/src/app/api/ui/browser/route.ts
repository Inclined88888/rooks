import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Toutes les sessions navigateur actives, tous projets confondus. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/browser');
}
