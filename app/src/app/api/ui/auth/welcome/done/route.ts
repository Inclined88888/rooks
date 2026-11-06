import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Closes the upgrade welcome for the signed-in account (docs/ONBOARDING.md, `Upgrade welcome`). */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/auth/welcome/done', {});
}
