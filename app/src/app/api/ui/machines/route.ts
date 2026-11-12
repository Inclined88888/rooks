import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The signed-in person's fleet. `/api/machines*` is anchored on the local
 * daemon (`lib/machines/target.ts`): whatever machine is active, this list is
 * the one this computer keeps — the switcher and the way back live on it.
 * Never a token: the route that hands one out answers the app relay only,
 * and no route here reaches it.
 */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/machines');
}
