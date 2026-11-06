'use client';

/**
 * Consent of a plugin to one secret, opened by its notification card
 * (`/secrets?grant=<NAME>&plugin=<id>`, TODO #597).
 *
 * Since #531 (1-B) a plugin reads only what is granted to `agent:plugin:<id>`;
 * a `global` grant no longer reaches it. The card used to name a CLI command as
 * the only way back. This dialog is the same decision made where the operator
 * already is: it names the secret, the plugin and what the plugin will be able
 * to do with it, and grants nothing until *Grant* is clicked. The daemon keeps
 * the decision superadmin-only and closes the card itself once the grant
 * exists.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import {
  PLUGIN_AGENT_PREFIX,
  consentTarget,
  grantKey,
  grantedToPlugin,
  parseBrokerSpec,
  scopeBadge,
  type PluginGrantRequest,
  type SecretSummary,
} from '@/lib/secrets';

async function errorText(res: Response): Promise<string> {
  const raw = (await res.text().catch(() => '')).trim();
  if (!raw) return `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(raw) as { error?: string; message?: string; reason?: string };
    return parsed.reason || parsed.error || parsed.message || raw;
  } catch {
    return raw;
  }
}

export function PluginGrantDialog({
  request,
  pluginLabel,
  onClose,
  onGranted,
}: {
  request: PluginGrantRequest | null;
  /** Display name of the plugin when it is installed; its id otherwise. */
  pluginLabel: string | null;
  onClose: () => void;
  onGranted: () => void;
}): React.ReactElement {
  // The whole vault, not the page's list: that one may be narrowed to a project.
  const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = request?.name ?? '';
  const pluginId = request?.plugin ?? '';

  useEffect(() => {
    setSecrets(null);
    setPicked(null);
    if (!name) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/ui/secrets', { cache: 'no-store' });
        if (!res.ok) throw new Error(await errorText(res));
        const json = (await res.json()) as { secrets?: SecretSummary[] };
        if (live) setSecrets(json.secrets ?? []);
      } catch (err) {
        if (live) setSecrets([]);
        toast.error(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { live = false; };
  }, [name, pluginId]);

  const target = secrets ? consentTarget(secrets, name) : null;
  const secret = target?.secret ?? target?.candidates.find((s) => s.id === picked) ?? null;
  const already = secret ? grantedToPlugin(secret, pluginId) : false;
  const plugin = pluginLabel && pluginLabel !== pluginId ? `${pluginLabel} (${pluginId})` : pluginId;
  const hosts = secret?.mode === 'broker' ? parseBrokerSpec(secret.broker_spec)?.hosts ?? [] : [];

  async function grant() {
    if (!secret) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/ui/secrets/${encodeURIComponent(secret.id)}/grants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: { scope_kind: 'agent', scope_ref: `${PLUGIN_AGENT_PREFIX}${pluginId}` } }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      toast.success(t('secretsPage.pluginGrant.done', { name, plugin }));
      onGranted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('secretsPage.pluginGrant.title')}</DialogTitle>
          <DialogDescription>{t('secretsPage.pluginGrant.ask', { name, plugin })}</DialogDescription>
        </DialogHeader>

        {secrets === null ? (
          <p className="text-[13px] text-muted-foreground">{t('common.loading')}</p>
        ) : target && target.candidates.length === 0 ? (
          <p className="text-[13px]" data-plugin-grant="missing">
            {t('secretsPage.pluginGrant.missing', { name })}
          </p>
        ) : (
          <div className="flex flex-col gap-3 text-[13px]">
            {!target?.secret && target ? (
              <div className="flex flex-col gap-1.5">
                <span>{t('secretsPage.pluginGrant.choose', { name })}</span>
                {target.candidates.map((s) => (
                  <label
                    key={s.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50',
                      picked === s.id && 'bg-primary/5',
                    )}
                  >
                    <input type="radio" checked={picked === s.id} onChange={() => setPicked(s.id)} />
                    <span className="flex flex-wrap gap-1">
                      {s.grants.length === 0 ? (
                        <Badge variant="outline">{t('secretsPage.daemonOnly')}</Badge>
                      ) : (
                        s.grants.map((g) => (
                          <Badge key={grantKey(g)} variant="outline">{scopeBadge(g, t)}</Badge>
                        ))
                      )}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            {secret && already ? (
              <p data-plugin-grant="already">{t('secretsPage.pluginGrant.already', { name, plugin })}</p>
            ) : secret ? (
              <>
                <p data-plugin-grant="effect">
                  {secret.mode === 'broker'
                    ? t('secretsPage.pluginGrant.broker', { hosts: hosts.join(', ') || '—' })
                    : t('secretsPage.pluginGrant.inject')}
                </p>
                <p className="text-muted-foreground">{t('secretsPage.pluginGrant.revoke')}</p>
              </>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {secret && !already ? (
            <Button disabled={busy} onClick={() => void grant()} data-plugin-grant="confirm">
              {t('secretsPage.pluginGrant.grant')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
