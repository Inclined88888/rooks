import { NextResponse } from 'next/server';
import { authenticate, clientIp } from '@/lib/remote/auth';
import { audit } from '@/lib/remote/audit';
import { getMission, killMission } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const auth = authenticate(req, `/missions/:id`);
  if (auth instanceof NextResponse) return auth;
  const mission = await getMission(params.id);
  if (!mission) {
    audit({ tokenId: auth.ctx.tokenId, clientName: auth.ctx.clientName, method: 'GET', path: `/missions/${params.id}`, status: 404, ip: clientIp(req) });
    return NextResponse.json({ error: 'mission not found' }, { status: 404 });
  }
  audit({ tokenId: auth.ctx.tokenId, clientName: auth.ctx.clientName, method: 'GET', path: `/missions/${params.id}`, status: 200, ip: clientIp(req) });
  return NextResponse.json({
    id: mission.id,
    agent: mission.agent_name,
    status: mission.status,
    running: mission.running,
    started_at: mission.started_at,
    ended_at: mission.ended_at,
    exit_code: mission.exit_code,
  });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const auth = authenticate(req, `/missions/:id`);
  if (auth instanceof NextResponse) return auth;
  const ok = await killMission(params.id);
  const status = ok ? 200 : 404;
  audit({ tokenId: auth.ctx.tokenId, clientName: auth.ctx.clientName, method: 'DELETE', path: `/missions/${params.id}`, status, ip: clientIp(req) });
  if (!ok) return NextResponse.json({ error: 'no running mission with that id' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
