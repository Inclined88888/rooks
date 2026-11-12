import { NextResponse } from 'next/server';
import { authenticateMaster, clientIp } from '@/lib/remote/auth';
import { audit } from '@/lib/remote/audit';
import { issueToken } from '@/lib/remote/token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const reject = authenticateMaster(req);
  if (reject) {
    audit({ tokenId: null, clientName: null, method: 'POST', path: '/issue-token', status: reject.status, ip: clientIp(req) });
    return reject;
  }
  const body = (await req.json().catch(() => ({}))) as { client_name?: string };
  if (!body.client_name) {
    audit({ tokenId: null, clientName: null, method: 'POST', path: '/issue-token', status: 400, ip: clientIp(req) });
    return NextResponse.json({ error: 'client_name required' }, { status: 400 });
  }
  const issued = issueToken(body.client_name);
  audit({ tokenId: issued.id, clientName: body.client_name, method: 'POST', path: '/issue-token', status: 201, ip: clientIp(req) });
  return NextResponse.json(
    { token: issued.token, token_id: issued.id, expires_at: issued.expires_at },
    { status: 201 },
  );
}
