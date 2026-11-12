import { switchActiveMachine } from '@/lib/machines/switch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `{ id }` → the machine this browser drives from now on (`local` = this
 * computer). Answered by the app itself: it checks the machine with the local
 * daemon, then writes the `nova_machine` cookie. The browser reloads the
 * whole document afterwards.
 */
export async function POST(req: Request): Promise<Response> {
  return switchActiveMachine(req);
}
