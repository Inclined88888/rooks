import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** { profile, at } — the signed-in account's onboarding profile (`null` until chosen). The daemon checks the session. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/onboarding/profile');
}

/** { profile } — written by the onboarding's profile step; the daemon validates the value and refuses an anonymous call. */
export async function PUT(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  return proxyJson('PUT', '/api/onboarding/profile', body);
}
