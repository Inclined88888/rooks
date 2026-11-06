import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 1:1 proxy: the support report (Settings › System, TODO #343). Superadmin is
 *  enforced by the daemon on the session cookie; `app` is the desktop version. */
export async function GET(request: Request): Promise<Response> {
  const app = new URL(request.url).searchParams.get('app');
  const query = app && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(app) ? `?app=${encodeURIComponent(app)}` : '';
  return proxyJson('GET', `/api/admin/system/diagnostic${query}`);
}
