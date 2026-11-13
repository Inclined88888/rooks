'use client';

/**
 * Settings › Access & network › Channels — WhatsApp setup.
 * Calm flat bar (no flags, mascots, glows). Both Cloud API and linked-device
 * paths, labelled with trade-offs. Local-first: no hosted Rooks webhook.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { WHATSAPP_WEB_RISKS } from '@/lib/channels/whatsapp-web-session';

type Mode = 'cloud' | 'web';

type ChannelSummary = {
  name: string;
  type: string;
  phone_number_id?: string;
  status?: { state?: string; qrDataUrl?: string; message?: string } | null;
};

export function ChannelsSettings(): ReactElement {
  const [mode, setMode] = useState<Mode>('cloud');
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [verifyToken, setVerifyToken] = useState<string | null>(null);
  const [webhookPath, setWebhookPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/ui/channels', { cache: 'no-store' });
      if (!res.ok) return;
      const json = await res.json() as { channels?: ChannelSummary[] };
      setChannels(json.channels ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const web = channels.find((c) => c.type === 'whatsapp-web');
    if (!web) return;
    const id = setInterval(() => { void refresh(); }, 2500);
    return () => clearInterval(id);
  }, [channels, refresh]);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const body = mode === 'cloud'
        ? {
            mode: 'cloud' as const,
            phone_number_id: phoneNumberId.trim(),
            access_token: accessToken.trim(),
            app_secret: appSecret.trim() || undefined,
          }
        : { mode: 'web' as const };
      const res = await fetch('/api/ui/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json() as {
        error?: string;
        verify_token?: string;
        webhook_path?: string;
        ok?: boolean;
      };
      if (!res.ok) {
        setError(json.error ?? t('channelsSettings.saveFailed'));
        return;
      }
      setVerifyToken(json.verify_token ?? null);
      setWebhookPath(json.webhook_path ?? null);
      setOk(t('channelsSettings.saved'));
      setAccessToken('');
      setAppSecret('');
      await refresh();
    } catch {
      setError(t('channelsSettings.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string): Promise<void> {
    setBusy(true);
    try {
      await fetch(`/api/ui/channels?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const whatsapp = channels.filter((c) => c.type === 'whatsapp-cloud' || c.type === 'whatsapp-web');
  const webStatus = whatsapp.find((c) => c.type === 'whatsapp-web')?.status;

  return (
    <div data-settings-pane="channels" className="flex max-w-[560px] flex-col gap-6">
      <div>
        <h2 className="text-[15px] font-semibold tracking-[-0.02em] text-foreground">
          {t('channelsSettings.title')}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          {t('channelsSettings.subtitle')}
        </p>
      </div>

      <div
        role="tablist"
        aria-label={t('channelsSettings.modeLabel')}
        className="flex w-full flex-col gap-0.5 rounded-lg border border-border bg-background p-1"
      >
        {([
          { id: 'cloud' as const, title: t('channelsSettings.cloud.title'), detail: t('channelsSettings.cloud.detail') },
          { id: 'web' as const, title: t('channelsSettings.web.title'), detail: t('channelsSettings.web.detail') },
        ]).map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={mode === opt.id}
            data-whatsapp-mode={opt.id}
            onClick={() => setMode(opt.id)}
            className={cn(
              'flex w-full items-start gap-3 rounded-md p-3 text-left transition-colors duration-150',
              'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              mode === opt.id && 'bg-muted',
            )}
          >
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-[12px] font-semibold text-foreground">
              {opt.id === 'cloud' ? 'API' : 'QR'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-foreground">{opt.title}</span>
              <span className="mt-0.5 block text-[12.5px] leading-snug text-muted-foreground">{opt.detail}</span>
            </span>
          </button>
        ))}
      </div>

      {mode === 'cloud' ? (
        <div className="flex flex-col gap-3" data-whatsapp-form="cloud">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {t('channelsSettings.cloud.tradeoffs')}
          </p>
          <label className="flex flex-col gap-1.5 text-[12.5px] text-muted-foreground">
            {t('channelsSettings.cloud.phoneNumberId')}
            <input
              data-whatsapp-field="phone_number_id"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-[13.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[12.5px] text-muted-foreground">
            {t('channelsSettings.cloud.accessToken')}
            <input
              data-whatsapp-field="access_token"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-[13.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[12.5px] text-muted-foreground">
            {t('channelsSettings.cloud.appSecret')}
            <input
              data-whatsapp-field="app_secret"
              type="password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-[13.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              autoComplete="off"
            />
          </label>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">{t('channelsSettings.cloud.tunnelTitle')}</p>
            <p className="mt-1">{t('channelsSettings.cloud.tunnelBody')}</p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11.5px] text-foreground/80">
{`# example — you run this, Rooks does not host
cloudflared tunnel --url http://127.0.0.1:3100
# or: ngrok http 3100
# Meta webhook URL: https://<tunnel>/api/channels/whatsapp/inbound`}
            </pre>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3" data-whatsapp-form="web">
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {t('channelsSettings.web.tradeoffs')}
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-[12.5px] leading-snug text-muted-foreground">
            {WHATSAPP_WEB_RISKS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {webStatus?.state === 'qr' && webStatus.qrDataUrl?.startsWith('data:text/plain') && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
              <p className="text-[12.5px] font-medium text-foreground">{t('channelsSettings.web.qrReady')}</p>
              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                {decodeURIComponent(webStatus.qrDataUrl.replace(/^data:text\/plain;charset=utf-8,/, ''))}
              </p>
            </div>
          )}
          {webStatus?.state === 'open' && (
            <p className="text-[12.5px] text-foreground">{t('channelsSettings.web.linked')}</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          data-whatsapp-save
          disabled={busy || (mode === 'cloud' && (!phoneNumberId.trim() || !accessToken.trim()))}
          onClick={() => { void save(); }}
          className={cn(
            'rounded-md bg-foreground px-3.5 py-2 text-[13px] font-medium text-background transition-opacity',
            'disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          {busy ? t('channelsSettings.saving') : t('channelsSettings.save')}
        </button>
        {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        {ok && <p className="text-[12.5px] text-muted-foreground">{ok}</p>}
      </div>

      {(verifyToken || webhookPath) && (
        <div className="rounded-md border border-border px-3 py-2.5 text-[12.5px] leading-relaxed">
          {webhookPath && (
            <p><span className="text-muted-foreground">{t('channelsSettings.cloud.webhookPath')} </span>
              <code className="font-mono text-foreground">{webhookPath}</code></p>
          )}
          {verifyToken && (
            <p className="mt-1"><span className="text-muted-foreground">{t('channelsSettings.cloud.verifyToken')} </span>
              <code className="font-mono text-foreground">{verifyToken}</code></p>
          )}
        </div>
      )}

      {whatsapp.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold text-foreground">{t('channelsSettings.configured')}</h3>
          <ul className="flex flex-col gap-0.5 rounded-lg border border-border p-1">
            {whatsapp.map((ch) => (
              <li key={ch.name} className="flex items-center justify-between gap-3 rounded-md px-3 py-2">
                <span className="min-w-0 text-[13px]">
                  <span className="font-medium text-foreground">{ch.name}</span>
                  <span className="ml-2 text-muted-foreground">{ch.type}</span>
                  {ch.phone_number_id && (
                    <span className="ml-2 font-mono text-[11.5px] text-muted-foreground">{ch.phone_number_id}</span>
                  )}
                  {ch.status?.state && (
                    <span className="ml-2 text-[11.5px] text-muted-foreground">{ch.status.state}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="text-[12.5px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => { void remove(ch.name); }}
                >
                  {t('channelsSettings.remove')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
