import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/ui/proxy-auth';

export const dynamic = 'force-dynamic';

// Reserve unknown API paths so they cannot fall through to the plugin page shell.
// A cookie is not proof of authentication: even its holder gets no resource here.
export function GET(req: NextRequest): Response {
  const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value?.trim());
  return Response.json(
    { error: hasCookie ? 'not_found' : 'unauthorized' },
    { status: hasCookie ? 404 : 401, headers: { 'cache-control': 'no-store' } },
  );
}

export { GET as POST, GET as PUT, GET as PATCH, GET as DELETE, GET as HEAD, GET as OPTIONS };
