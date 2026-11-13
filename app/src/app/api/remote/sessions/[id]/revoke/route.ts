import { NextResponse } from 'next/server';
import { authenticateMaster, clientIp } from '@/lib/remote/auth';
import { audit } from '@/lib/remote/audit';
import { revokeToken } from '@/lib/remote/token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const reject = authenticateMaster(req);
  if (reject) return reject;
  const ok = revokeToken(params.id);
  audit({ tokenId: params.id, clientName: null, method: 'POST', path: `/sessions/${params.id}/revoke`, status: ok ? 200 : 404, ip: clientIp(req) });
  if (!ok) return NextResponse.json({ error: 'token not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
