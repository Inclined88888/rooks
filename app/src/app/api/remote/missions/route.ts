import { NextResponse } from 'next/server';
import { authenticate, clientIp } from '@/lib/remote/auth';
import { audit } from '@/lib/remote/audit';
import { spawnMission } from '@/lib/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const auth = authenticate(req, '/missions');
  if (auth instanceof NextResponse) return auth;
  const body = (await req.json().catch(() => ({}))) as { agent?: string; input?: string };
  if (!body.agent || !body.input) {
    audit({ tokenId: auth.ctx.tokenId, clientName: auth.ctx.clientName, method: 'POST', path: '/missions', status: 400, ip: clientIp(req) });
    return NextResponse.json({ error: 'agent and input required' }, { status: 400 });
  }
  const missionId = await spawnMission({
    agent: body.agent,
    mission: body.input,
    sourceChannel: 'remote',
    sourceMeta: { client: auth.ctx.clientName },
  });
  audit({ tokenId: auth.ctx.tokenId, clientName: auth.ctx.clientName, method: 'POST', path: '/missions', status: 201, ip: clientIp(req) });
  return NextResponse.json({ mission_id: missionId }, { status: 201 });
}
