import { NextResponse } from 'next/server';
import { listChannels } from '@/lib/channels/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return NextResponse.json({
    ok: true,
    channels: listChannels().map((c) => ({ name: c.name, type: c.config.type })),
  });
}
