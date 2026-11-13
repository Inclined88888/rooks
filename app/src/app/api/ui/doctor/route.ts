import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 1:1 proxy: full diagnostic of the daemon's machine — resolved binaries,
 *  host capabilities, blockers. The first-run wizard prefills its binary
 *  fields from it, and `rooks doctor` renders the very same report. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/doctor');
}
