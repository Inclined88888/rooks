'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';
import { formatRelativeTime } from '@/lib/intl';
import { apiErrorMessage } from '@/lib/api-error';

type Dream = {
  id: number;
  kind: 'improve' | 'opportunity';
  project: string | null;
  title: string;
  body: string;
  rationale: string | null;
  effort: string | null;
  conviction: number | null;
  sources: string | null;
  status: string;
  created_at: number;
};

type Tab = 'active' | 'accepted' | 'rejected' | 'snoozed';

const TAB_LABELS: Record<Tab, string> = {
  active: i18n('dreamsPage.tabActive'),
  accepted: i18n('dreamsPage.tabAccepted'),
  snoozed: i18n('dreamsPage.tabSnoozed'),
  rejected: i18n('dreamsPage.tabRejected'),
};

const KIND = {
  improve: { icon: '🔧', label: i18n('dreamsPage.improve'), cls: 'border-l-sky-500' },
  opportunity: { icon: '💡', label: i18n('dreamsPage.opportunity'), cls: 'border-l-amber-500' },
} as const;

export function DreamsClient() {
  const [tab, setTab] = useState<Tab>('active');
  const [dreams, setDreams] = useState<Dream[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [showInstr, setShowInstr] = useState(false);
  const [instr, setInstr] = useState('');
  const [savingInstr, setSavingInstr] = useState(false);
  // Dreaming ON/OFF toggle (e.g. disable during vacation). Persisted on the
  // orchestrator side, read every night.
  const [enabled, setEnabled] = useState(true);
  const [togglingEnabled, setTogglingEnabled] = useState(false);

  const openInstr = useCallback(async () => {
    setShowInstr(true);
    try {
      const r = await fetch('/api/ui/dreams/instructions', { cache: 'no-store' });
      const j = await r.json();
      setInstr(j.text ?? '');
    } catch {
      toast.error(i18n('dreamsPage.loadInstrError'));
    }
  }, []);

  const saveInstr = useCallback(async () => {
    setSavingInstr(true);
    try {
      const r = await fetch('/api/ui/dreams/instructions', {
        method: 'PUT',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: instr,
      });
      if (!r.ok) throw new Error(await r.text());
      toast.success(i18n('dreamsPage.instrSaved'));
      setShowInstr(false);
    } catch (e) {
      toast.error(String((e as Error).message || e).slice(0, 120));
    } finally {
      setSavingInstr(false);
    }
  }, [instr]);

  const load = useCallback(async (t: Tab) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/ui/dreams?status=${t}`, { cache: 'no-store' });
      const j = await r.json();
      setDreams((j.dreams ?? []) as Dream[]);
    } catch {
      toast.error(i18n('dreamsPage.loadError'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(tab); }, [tab, load]);

  const decide = useCallback(async (id: number, status: 'accepted' | 'rejected' | 'snoozed', snooze_days?: number) => {
    setBusy(id);
    try {
      const r = await fetch(`/api/ui/dreams/${id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, snooze_days }),
      });
      if (!r.ok) throw new Error(await r.text());
      const label = status === 'accepted' ? i18n('dreamsPage.kept') : status === 'rejected' ? i18n('dreamsPage.rejected') : i18n('dreamsPage.snoozed');
      toast.success(i18n('dreamsPage.dreamStatus', { label }));
      setDreams((d) => d.filter((x) => x.id !== id));
    } catch (e) {
      toast.error(String((e as Error).message || e).slice(0, 100));
    } finally {
      setBusy(null);
    }
  }, []);

  const runNow = useCallback(async () => {
    setRunning(true);
    toast(i18n('dreamsPage.dreamingToast'));
    try {
      const r = await fetch('/api/ui/dreams/run', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(j, i18n('dreamsPage.failed')));
      toast.success(i18n('dreamsPage.dreamDone', { improve: j.improve ?? 0, opportunity: j.opportunity ?? 0 }));
      if (tab === 'active') void load('active');
    } catch (e) {
      toast.error(String((e as Error).message || e).slice(0, 120));
    } finally {
      setRunning(false);
    }
  }, [tab, load]);

  // Loads the ON/OFF state on mount.
  useEffect(() => {
    fetch('/api/ui/dreams/config', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setEnabled(j.enabled !== false))
      .catch(() => { /* default: enabled */ });
  }, []);

  const toggleEnabled = useCallback(async () => {
    const next = !enabled;
    setTogglingEnabled(true);
    try {
      const r = await fetch('/api/ui/dreams/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(j, i18n('dreamsPage.failed')));
      setEnabled(j.enabled !== false);
      toast.success(next ? i18n('dreamsPage.dreamingEnabled') : i18n('dreamsPage.dreamingDisabled'));
    } catch (e) {
      toast.error(String((e as Error).message || e).slice(0, 120));
    } finally {
      setTogglingEnabled(false);
    }
  }, [enabled]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 bg-background px-4 py-2.5">
        <h1 className="mr-2 text-sm font-semibold">🌙 Dreams</h1>
        <div className="inline-flex gap-0.5 rounded-md border border-border bg-muted/30 p-0.5">
          {(['active', 'accepted', 'snoozed', 'rejected'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
                tab === t ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={toggleEnabled}
            disabled={togglingEnabled}
            title={enabled ? i18n('dreamsPage.toggleOnTitle') : i18n('dreamsPage.toggleOffTitle')}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50',
              enabled
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/15'
                : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground',
            )}
          >
            <span className={cn('size-1.5 rounded-full', enabled ? 'bg-emerald-400' : 'bg-muted-foreground/50')} />
            {enabled ? i18n('dreamsPage.dreamingOn') : i18n('dreamsPage.dreamingOff')}
          </button>
          <Button size="sm" variant="outline" onClick={() => (showInstr ? setShowInstr(false) : void openInstr())}>
            ⚙️ {i18n('dreamsPage.instructions')}
          </Button>
          <Button size="sm" onClick={runNow} disabled={running} className="font-semibold">
            {running ? i18n('dreamsPage.dreaming') : i18n('dreamsPage.dreamNow')}
          </Button>
        </div>
      </div>

      {showInstr && (
        <div className="bg-muted/20 px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <p className="mb-2 text-[12px] text-muted-foreground">
              {i18n('dreamsPage.instrHelp1')} <code>## General</code> / <code>## Improvements</code> / <code>## Opportunities</code>. {i18n('dreamsPage.instrHelp2')}
            </p>
            <Textarea
              value={instr}
              onChange={(e) => setInstr(e.target.value)}
              rows={12}
              // code-font: markdown source being edited
              className="font-mono text-[12px]"
              placeholder={i18n('common.loading')}
            />
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" onClick={saveInstr} disabled={savingInstr} className="font-semibold">
                {savingInstr ? i18n('dreamsPage.saving') : i18n('common.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowInstr(false)}>{i18n('common.close')}</Button>
            </div>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-4 py-5">
          {tab === 'active' && (
            <p className="mb-4 text-[12px] text-muted-foreground">
              {i18n('dreamsPage.activeHelp')}
            </p>
          )}
          {loading ? (
            <p className="text-[13px] text-muted-foreground">{i18n('common.loading')}</p>
          ) : dreams.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {tab === 'active' ? i18n('dreamsPage.noneActive') : i18n('dreamsPage.nothingHere')}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {dreams.map((d) => {
                const k = KIND[d.kind];
                const sources: string[] = (() => { try { return JSON.parse(d.sources || '[]'); } catch { return []; } })();
                return (
                  <div key={d.id} className={cn('rounded-md border border-l-4 bg-card p-3.5 shadow-sm', k.cls)}>
                    <div className="mb-1.5 flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{k.icon} {k.label}</Badge>
                      {d.project && <Badge variant="secondary" className="text-[10px]">{d.project}</Badge>}
                      {d.effort && <Badge variant="outline" className="text-[10px]">{i18n('dreamsPage.effort')} {d.effort}</Badge>}
                      {d.conviction != null && (
                        <span className="text-[10px] text-muted-foreground">{i18n('dreamsPage.conviction')} {d.conviction}/100</span>
                      )}
                      <span className="ml-auto text-[10px] text-muted-foreground">{formatRelativeTime(d.created_at)}</span>
                    </div>
                    <h3 className="text-[14px] font-semibold leading-snug">{d.title}</h3>
                    <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">{d.body}</p>
                    {d.rationale && (
                      <p className="mt-1.5 text-[12px] italic text-muted-foreground">→ {d.rationale}</p>
                    )}
                    {sources.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {sources.map((u, i) => (
                          <a key={i} href={u} target="_blank" rel="noreferrer" className="text-[11px] text-sky-500 underline underline-offset-2 hover:text-sky-400">
                            {i18n('dreamsPage.source')} {i + 1}
                          </a>
                        ))}
                      </div>
                    )}
                    {tab === 'active' && (
                      <div className="mt-3 flex items-center gap-2">
                        <Button size="sm" variant="default" disabled={busy === d.id} onClick={() => decide(d.id, 'accepted')}>
                          {i18n('dreamsPage.keep')}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy === d.id} onClick={() => decide(d.id, 'snoozed', 14)}>
                          {i18n('dreamsPage.snooze')}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy === d.id} onClick={() => decide(d.id, 'rejected')} className="text-muted-foreground">
                          {i18n('dreamsPage.reject')}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
