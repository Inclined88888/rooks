/**
 * The permissions still pending (proxy to the orchestrator).
 *
 * Exists to RECOVER a form card (`ask_user` in the database) whose payload
 * never reached the component (incident 2026-08-21): rather than leave the
 * human facing a blind choice, the card asks for its `input` again here and
 * renders the form again. The pending entry's `input` field holds the questions.
 */
import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const missionId = new URL(req.url).searchParams.get('mission_id');
  const qs = missionId ? `?mission_id=${encodeURIComponent(missionId)}` : '';
  return proxyJson('GET', `/api/permissions${qs}`);
}
