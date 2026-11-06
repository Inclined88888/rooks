'use client';

/**
 * Settings → AI models → Providers: the long-lived claude token (`claude setup-token`).
 * Write-only like the vault: the daemon never sends the value back, so the
 * field is always empty and only says whether a token is stored.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';

const API = '/api/ui/backends/claude-token';

export type ClaudeTokenState = { configured: boolean; readable: boolean; serviceOutsideSession: boolean };

/** Which status line to show; exported for the test. */
export function claudeTokenStateKey(state: ClaudeTokenState): string {
  if (!state.configured) return 'backendsSettings.claudeToken.none';
  return state.readable ? 'backendsSettings.claudeToken.set' : 'backendsSettings.claudeToken.unreadable';
}

async function errorOf(res: Response): Promise<string> {
  if (res.status === 403 || res.status === 401) return t('backendsSettings.errors.forbidden');
  const body = await res.json().catch(() => null) as { error?: string } | null;
  return apiErrorMessage(body, { status: res.status });
}

export function ClaudeTokenPanel(): ReactElement | null {
  const [state, setState] = useState<ClaudeTokenState | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(API, { cache: 'no-store' }).catch(() => null);
    if (res?.ok) setState(await res.json() as ClaudeTokenState);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function send(method: 'PUT' | 'DELETE') {
    setBusy(true);
    try {
      const res = await fetch(API, {
        method, cache: 'no-store',
        ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: value }) } : {}),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      setState(await res.json() as ClaudeTokenState);
      setValue('');
      toast.success(t(method === 'PUT' ? 'backendsSettings.claudeToken.saved' : 'backendsSettings.claudeToken.cleared'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Not a superadmin, or an older daemon: nothing to offer.
  if (!state) return null;
  return (
    <form
      className="mt-6 max-w-xl space-y-2 rounded-md border border-border bg-card p-4"
      onSubmit={(event) => { event.preventDefault(); if (value.trim()) void send('PUT'); }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="claude-token" className="text-sm font-medium">{t('backendsSettings.claudeToken.title')}</Label>
        <Badge variant={state.configured && state.readable ? 'default' : 'outline'}>{t(claudeTokenStateKey(state))}</Badge>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('backendsSettings.claudeToken.hint')}</p>
      {state.serviceOutsideSession && !state.readable ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{t('backendsSettings.claudeToken.required')}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="claude-token" type="password" autoComplete="off" spellCheck={false} className="max-w-sm flex-1"
          value={value} placeholder="sk-ant-oat01-…" onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || !value.trim()}>{t('backendsSettings.save')}</Button>
        {state.configured ? (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void send('DELETE')}>
            {t('backendsSettings.claudeToken.clear')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
