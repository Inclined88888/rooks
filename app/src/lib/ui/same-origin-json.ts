import { headers } from 'next/headers';

/** A browser on another site must not reach setup or local sign-in through this proxy. */
export function sameOriginJson(req: Request): { ok: true; body: Record<string, unknown> } | { ok: false; response: Response } {
  const incoming = headers();
  const site = incoming.get('sec-fetch-site');
  if (site === 'cross-site') return { ok: false, response: Response.json({ error: 'cross_site' }, { status: 403 }) };
  const origin = incoming.get('origin');
  if (origin === 'null') return { ok: false, response: Response.json({ error: 'cross_site' }, { status: 403 }) };
  const host = incoming.get('x-forwarded-host')?.split(',')[0]?.trim() || incoming.get('host')?.trim();
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return { ok: false, response: Response.json({ error: 'cross_site' }, { status: 403 }) };
    } catch {
      return { ok: false, response: Response.json({ error: 'cross_site' }, { status: 403 }) };
    }
  }
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/json')) return { ok: false, response: Response.json({ error: 'json_required' }, { status: 415 }) };
  return { ok: true, body: {} };
}

export async function readSameOriginJson(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const gate = sameOriginJson(req);
  if (!gate.ok) return gate;
  try {
    const body = await req.json() as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, response: Response.json({ error: 'json_required' }, { status: 400 }) };
    }
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, response: Response.json({ error: 'json_required' }, { status: 400 }) };
  }
}

/** The desktop shell's per-launch nonce. Absent outside the packaged app, so tests stay open. */
export function setupNonceHeader(): Record<string, string> {
  const nonce = process.env.ROOKS_SETUP_NONCE?.trim();
  return nonce ? { 'x-rooks-setup-nonce': nonce } : {};
}
