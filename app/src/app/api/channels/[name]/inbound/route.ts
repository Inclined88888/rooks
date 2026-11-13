import { NextResponse } from 'next/server';
import { loadChannelConfig } from '@/lib/channels/config';
import { routeMessage } from '@/lib/channels/router';
import { channelStore, ChannelQueueFull } from '@/lib/channels/store';
import { InboundError, normalizeInbound, readInboundBody, verifyWhatsAppCloudChallenge } from '@/lib/channels/inbound';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Meta WhatsApp Cloud API subscription verification (hub.challenge). */
export async function GET(
  req: Request,
  { params }: { params: { name: string } },
): Promise<Response> {
  try {
    const cfg = loadChannelConfig(params.name);
    if (!cfg || cfg.type !== 'whatsapp-cloud') {
      return NextResponse.json({ error: 'unknown channel' }, { status: 404 });
    }
    const challenge = verifyWhatsAppCloudChallenge(cfg, new URL(req.url));
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
  } catch (error) {
    if (error instanceof InboundError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[inbound] verify failed');
    return NextResponse.json({ error: 'channel unavailable' }, { status: 503 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: { name: string } },
): Promise<Response> {
  try {
    const name = params.name;
    const cfg = loadChannelConfig(name);
    if (!cfg) return NextResponse.json({ error: 'unknown channel' }, { status: 404 });
    const inbound = normalizeInbound(name, cfg, await readInboundBody(req), req.headers);
    const { agent, cleanedText } = routeMessage(inbound.text, cfg.default_agent, cfg.agent_routing);
    const receipt = channelStore().accept({ ...inbound, text: cleanedText }, agent, inbound.externalId!);
    return NextResponse.json({ ok: true, receipt_id: receipt.id, mission_id: receipt.mission_id }, { status: 202 });
  } catch (error) {
    if (error instanceof InboundError || error instanceof ChannelQueueFull) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[inbound] request failed');
    return NextResponse.json({ error: 'channel unavailable' }, { status: 503 });
  }
}
