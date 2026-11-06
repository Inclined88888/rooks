import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Deleted agents (TODO #476). Auth is the daemon's: the session cookie rides
// along, and `/api/agent-trash` refuses an anonymous caller.
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/agent-trash');
}
