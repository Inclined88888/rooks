'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';

/** `GET /api/plugins/<id>/-/webhooks`: status only, the daemon never returns a secret here. */
export type PluginWebhookRow = {
  name: string;
  path: string;
  /** Signature format the manifest declares (`standard`, `github`, `stripe`…). */
  auth: string;
  label: string;
  level: 'strong' | 'signed' | 'signed-body' | 'weak';
  secretSources: Array<'generated' | 'provided'>;
  secretKind: 'secret' | 'public-key';
  needsRegeneration: boolean;
  /** Why the stored secret stopped working: the format changed, or another package took the plugin's id. */
  regenerationReason?: 'format' | 'publisher' | null;
  configured: boolean;
  listening: boolean;
  previousUntil: number | null;
  owner: { id: string; name: string } | null;
};

/** Shown once, then gone: a generated secret, or the verify token of a pasted one. */
type Fresh = { name: string; kind: 'secret' | 'verifyToken'; value: string };

function copy(value: string, key: string): void {
  void navigator.clipboard?.writeText(value);
  toast.success(t(key));
}

/**
 * The incoming webhooks a plugin declares: the address to give the sending
 * service, its signature format, and its secret. A secret the host generates
 * exists in this component only between the answer that carries it and
 * "Done" — masked, copied from memory, never rendered; one the service made
 * is pasted into a password field and never comes back from the daemon.
 */
export function PluginWebhooksPane({ pluginId }: { pluginId: string }): ReactElement | null {
  const [rows, setRows] = useState<PluginWebhookRow[]>([]);
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pasting, setPasting] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const base = `/api/ui/plugins/${encodeURIComponent(pluginId)}/-/webhooks`;

  useEffect(() => {
    setFresh(null);
    setPasting(null);
    void fetch(base, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { webhooks: [] }))
      .then((v: { webhooks?: PluginWebhookRow[] }) => setRows(v.webhooks ?? []));
  }, [base]);

  const replace = useCallback((row: PluginWebhookRow) => {
    setRows((all) => all.map((r) => (r.name === row.name ? row : r)));
  }, []);

  const call = useCallback(async (name: string, action: 'secret' | 'revoke-previous' | 'provided-secret', body: Record<string, unknown> = {}) => {
    setBusy(name);
    const response = await fetch(`${base}/${encodeURIComponent(name)}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
    });
    setBusy(null);
    if (!response.ok) {
      const key = response.status === 403 ? 'pluginWebhooks.forbidden' : response.status === 400 ? 'pluginWebhooks.invalid' : 'pluginWebhooks.error';
      toast.error(t(key));
      return false;
    }
    const answer = await response.json() as { secret?: string; verifyToken?: string; webhook: PluginWebhookRow };
    replace(answer.webhook);
    if (answer.secret) setFresh({ name, kind: 'secret', value: answer.secret });
    else if (answer.verifyToken) setFresh({ name, kind: 'verifyToken', value: answer.verifyToken });
    else toast.success(t(action === 'provided-secret' ? 'pluginWebhooks.saved' : 'pluginWebhooks.revoked'));
    return true;
  }, [base, replace]);

  const submitPasted = useCallback(async (event: FormEvent, name: string) => {
    event.preventDefault();
    const value = pasted.trim();
    if (!value) return;
    if (await call(name, 'provided-secret', { secret: value })) { setPasted(''); setPasting(null); }
  }, [call, pasted]);

  if (!rows.length) return null;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <section className="mt-8">
      <h3 className="text-[13px] font-medium">{t('pluginWebhooks.title')}</h3>
      <p className="mt-1 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('pluginWebhooks.description')}</p>
      <div className="mt-3 flex flex-col gap-3">
        {rows.map((row) => {
          const url = `${origin}${row.path}`;
          const canGenerate = row.secretSources.includes('generated');
          const canPaste = row.secretSources.includes('provided');
          const publicKey = row.secretKind === 'public-key';
          return (
            <div key={row.name} className="flex flex-col gap-2 rounded-lg bg-muted/20 p-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[12px] font-medium">{row.name}</span>
                <span className="text-[11px] text-muted-foreground">{row.label}</span>
                <span className="text-[11px] text-muted-foreground">
                  · {row.configured && !row.needsRegeneration ? t('pluginWebhooks.configured') : t('pluginWebhooks.notConfigured')}
                </span>
              </div>
              <p className={`text-[11px] ${row.level === 'weak' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                {t(`pluginWebhooks.level.${row.level}`)}
              </p>
              {row.needsRegeneration && (
                <p role="alert" className="text-[11px] text-amber-600 dark:text-amber-400">{row.regenerationReason === 'publisher'
                  ? t('pluginWebhooks.needsRegenerationPublisher')
                  : t('pluginWebhooks.needsRegeneration', { format: row.label })}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {/* code-font: the address is pasted as is into the sending service. */}
                <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1 font-mono text-[11px]">{url}</code>
                <Button type="button" size="sm" variant="ghost" aria-label={t('pluginWebhooks.copyUrl')} onClick={() => copy(url, 'pluginWebhooks.urlCopied')}>
                  <Copy className="size-3.5" />
                </Button>
                {canGenerate && (
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" disabled={busy === row.name} onClick={() => void call(row.name, 'secret')}>
                    {row.configured && !row.needsRegeneration ? t('pluginWebhooks.regenerate') : t('pluginWebhooks.generate')}
                  </Button>
                )}
                {canPaste && pasting !== row.name && (
                  <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" disabled={busy === row.name} onClick={() => { setPasted(''); setPasting(row.name); }}>
                    {t(publicKey ? 'pluginWebhooks.pastePublicKey' : 'pluginWebhooks.paste')}
                  </Button>
                )}
              </div>
              {pasting === row.name && (
                <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void submitPasted(event, row.name)}>
                  <Input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={pasted}
                    onChange={(event) => setPasted(event.target.value)}
                    aria-label={t(publicKey ? 'pluginWebhooks.publicKeyLabel' : 'pluginWebhooks.pastedLabel', { format: row.label })}
                    placeholder={t(publicKey ? 'pluginWebhooks.publicKeyPlaceholder' : 'pluginWebhooks.pastePlaceholder', { format: row.label })}
                    className="h-8 min-w-0 flex-1 text-[12px]"
                  />
                  <Button type="submit" size="sm" className="h-8" disabled={busy === row.name || !pasted.trim()}>{t('pluginWebhooks.save')}</Button>
                  <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => { setPasted(''); setPasting(null); }}>{t('pluginWebhooks.cancel')}</Button>
                </form>
              )}
              {row.configured && (
                <p className="text-[11px] text-muted-foreground">
                  {row.owner ? t('pluginWebhooks.actsAs', { name: row.owner.name }) : t('pluginWebhooks.actsAsPlugin')}
                  {!row.listening && <> · {t('pluginWebhooks.notListening')}</>}
                </p>
              )}
              {row.previousUntil !== null && (
                <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {t('pluginWebhooks.previousUntil', { date: formatDateTime(row.previousUntil) })}
                  <Button type="button" size="sm" variant="ghost" className="h-6 text-[11px]" disabled={busy === row.name} onClick={() => void call(row.name, 'revoke-previous')}>
                    {t('pluginWebhooks.revokePrevious')}
                  </Button>
                </p>
              )}
              {fresh?.name === row.name && (
                <div className="rounded-md bg-background p-3">
                  <p role="alert" className="text-[12px] text-muted-foreground">
                    {t(fresh.kind === 'secret' ? 'pluginWebhooks.once' : 'pluginWebhooks.verifyTokenOnce')}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    {/* Masked, and not even in the DOM: copied from memory only. */}
                    <span
                      aria-label={t(fresh.kind === 'secret' ? 'pluginWebhooks.secretLabel' : 'pluginWebhooks.verifyTokenLabel')}
                      className="w-full select-none rounded-md bg-muted/30 px-3 py-1 text-sm tracking-widest text-muted-foreground"
                    >
                      {'•'.repeat(24)}
                    </span>
                    <Button
                      type="button" size="sm" variant="outline" className="gap-1.5"
                      onClick={() => copy(fresh.value, fresh.kind === 'secret' ? 'pluginWebhooks.secretCopied' : 'pluginWebhooks.verifyTokenCopied')}
                    >
                      <Copy className="size-3.5" />{t(fresh.kind === 'secret' ? 'pluginWebhooks.copySecret' : 'pluginWebhooks.copyVerifyToken')}
                    </Button>
                    <Button type="button" size="sm" onClick={() => setFresh(null)}>{t('pluginWebhooks.done')}</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
