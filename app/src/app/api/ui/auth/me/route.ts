import { withActingAccount } from '@/lib/machines/acting-me';
import { resolveTarget } from '@/lib/machines/target';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The local session's account, plus the one it acts as on the active
 *  machine when that machine is another one (`lib/machines/acting-account.ts`). */
export async function GET(): Promise<Response> {
  const [local, target] = await Promise.all([proxyJson('GET', '/api/auth/me'), resolveTarget()]);
  return withActingAccount(local, target);
}
