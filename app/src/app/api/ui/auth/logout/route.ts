import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { machineCookie, secureRequest } from '@/lib/machines/switch';
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const answer = await proxyJson('POST', '/api/auth/logout', {});
  // Signing out also forgets the machine this browser was switched to: the
  // next person to sign in here starts on this computer, and the login page
  // is not replaced by the screen of a machine nobody can reach any more.
  // Whatever the daemon answered — the person asked to leave.
  answer.headers.append('set-cookie', machineCookie(LOCAL_MACHINE_ID, secureRequest(req)));
  return answer;
}
