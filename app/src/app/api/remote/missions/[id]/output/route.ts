import { NextResponse } from 'next/server';
import { authenticate, clientIp } from '@/lib/remote/auth';
import { audit } from '@/lib/remote/audit';
import { extractAssistantText, getMission } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const auth = authenticate(req, `/missions/:id/output`);
  if (auth instanceof NextResponse) return auth;
  const mission = await getMission(params.id);
  if (!mission) {
    audit({ tokenId: auth.ctx.tokenId, clientName: auth.ctx.clientName, method: 'GET', path: `/missions/${params.id}/output`, status: 404, ip: clientIp(req) });
    return NextResponse.json({ error: 'mission not found' }, { status: 404 });
  }
  const text = extractAssistantText(mission.events);
  audit({ tokenId: auth.ctx.tokenId, clientName: auth.ctx.clientName, method: 'GET', path: `/missions/${params.id}/output`, status: 200, ip: clientIp(req) });

  const wantsJson = (req.headers.get('accept') ?? '').includes('application/json');
  if (wantsJson) {
    return NextResponse.json({
      mission_id: mission.id,
      status: mission.status,
      running: mission.running,
      output_markdown: text,
    });
  }
  return new NextResponse(text, {
    status: 200,
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
}
