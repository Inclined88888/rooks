import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 1:1 proxy: does this machine already hold an instance to come back to, and
 *  the gesture that ends onboarding for it (step 2). */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/setup/resume');
}

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  return proxyJson('POST', '/api/setup/resume', body);
}
