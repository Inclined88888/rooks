import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import {
  deleteChannelConfig,
  listChannels,
  saveChannelConfig,
  upsertSecretsEnv,
  validateChannelConfig,
} from '@/lib/channels/config';
import { readWhatsAppWebStatus } from '@/lib/channels/transports/whatsapp-web';
import type { ChannelConfig } from '@/lib/channels/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public channel summary — never includes secret values. */
function summarize(name: string, config: ChannelConfig) {
  const base = { name, type: config.type, default_agent: config.default_agent };
  if (config.type === 'whatsapp-cloud') {
    return {
      ...base,
      phone_number_id: config.phone_number_id,
      has_app_secret: Boolean(config.app_secret_env),
      graph_version: config.graph_version ?? 'v21.0',
    };
  }
  if (config.type === 'whatsapp-web') {
    return {
      ...base,
      status: readWhatsAppWebStatus(name),
      session_dir: config.session_dir ?? null,
    };
  }
  return base;
}

export async function GET(): Promise<Response> {
  try {
    const channels = listChannels().map(({ name, config }) => summarize(name, config));
    return NextResponse.json({ channels });
  } catch (error) {
    console.error('[channels] list failed');
    return NextResponse.json({ error: 'channel unavailable' }, { status: 503 });
  }
}

type CloudBody = {
  mode: 'cloud';
  name?: string;
  default_agent?: string;
  phone_number_id?: string;
  access_token?: string;
  verify_token?: string;
  app_secret?: string;
  graph_version?: string;
};

type WebBody = {
  mode: 'web';
  name?: string;
  default_agent?: string;
};

/**
 * Save WhatsApp channel setup from Settings.
 * Secrets go to `~/.rooks/secrets.env`; config to `~/.rooks/channels/<name>.json`.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json() as CloudBody | WebBody;
    const name = (body.name ?? 'whatsapp').trim() || 'whatsapp';
    const defaultAgent = (body.default_agent ?? 'main').trim() || 'main';

    if (body.mode === 'cloud') {
      const phone = String(body.phone_number_id ?? '').trim();
      const access = String(body.access_token ?? '').trim();
      const verify = String(body.verify_token ?? '').trim() || randomBytes(16).toString('hex');
      const appSecret = String(body.app_secret ?? '').trim();
      if (!phone || !access) {
        return NextResponse.json({ error: 'phone_number_id and access_token required' }, { status: 400 });
      }
      const secrets: Record<string, string> = {
        WHATSAPP_ACCESS_TOKEN: access,
        WHATSAPP_VERIFY_TOKEN: verify,
      };
      if (appSecret) secrets.WHATSAPP_APP_SECRET = appSecret;
      upsertSecretsEnv(secrets);
      const config = validateChannelConfig({
        type: 'whatsapp-cloud',
        default_agent: defaultAgent,
        phone_number_id: phone,
        access_token_env: 'WHATSAPP_ACCESS_TOKEN',
        verify_token_env: 'WHATSAPP_VERIFY_TOKEN',
        ...(appSecret ? { app_secret_env: 'WHATSAPP_APP_SECRET' } : {}),
        ...(body.graph_version ? { graph_version: body.graph_version } : {}),
      });
      saveChannelConfig(name, config);
      return NextResponse.json({
        ok: true,
        channel: summarize(name, config),
        verify_token: verify,
        webhook_path: `/api/channels/${encodeURIComponent(name)}/inbound`,
        tunnel_hint: 'Expose this path with a local tunnel you run (cloudflared / ngrok). Rooks does not host webhooks.',
      });
    }

    if (body.mode === 'web') {
      const workerSecret = randomBytes(24).toString('hex');
      upsertSecretsEnv({ WHATSAPP_WEB_WORKER_SECRET: workerSecret });
      const config = validateChannelConfig({
        type: 'whatsapp-web',
        default_agent: defaultAgent,
        worker_secret_env: 'WHATSAPP_WEB_WORKER_SECRET',
        session_dir: 'channels/whatsapp-web-session',
      });
      saveChannelConfig(name, config);
      return NextResponse.json({
        ok: true,
        channel: summarize(name, config),
        risks: true,
      });
    }

    return NextResponse.json({ error: 'mode must be cloud or web' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'channel unavailable';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const name = url.searchParams.get('name') ?? 'whatsapp';
    const ok = deleteChannelConfig(name);
    return NextResponse.json({ ok });
  } catch {
    return NextResponse.json({ error: 'channel unavailable' }, { status: 503 });
  }
}
