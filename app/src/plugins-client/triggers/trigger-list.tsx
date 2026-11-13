'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { isModuleOn, useCapabilities } from '@/lib/capabilities';
import { fmtDate } from '../routines/routines-page';
import { requestJson, triggerApi, TRIGGERS_API } from './api';
import {
  hookUrl, type AuthScheme, type EventConfig, type ScheduleConfig, type TriggerPublic, type TriggerSource, type WebhookConfig,
} from './model';
import { copyWithToast } from './modal';
import { SecretDialog } from './secret-dialog';
import { JournalDialog, TestDialog } from './test-and-journal';
import { TriggerEditor, type SavedTrigger, type WorkflowChoice } from './trigger-editor';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

const CHIP = 'rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground';
const ROW_BUTTON = 'rounded border border-border bg-muted/30 px-2 py-1 text-[10.5px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100';

function sourceChip(trigger: TriggerPublic): string {
  const config = trigger.config;
  if (!config) return trigger.source;
  if (trigger.source === 'schedule') return (config as ScheduleConfig).cron;
  if (trigger.source === 'webhook') return t(`triggersPage.auth.${(config as WebhookConfig).auth}`);
  return t(`triggersPage.events.${(config as EventConfig).event}`);
}

export type TriggerListState =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'failed'; error: string }
  | { kind: 'ready'; triggers: TriggerPublic[] };

/** `/api/ui/triggers?source=…`, polled like the routines list. */
export function useTriggers(source: TriggerSource, excludeRoutines: boolean): { state: TriggerListState; reload: () => Promise<void> } {
  const [state, setState] = useState<TriggerListState>({ kind: 'loading' });
  const reload = useCallback(async () => {
    const res = await requestJson<{ triggers: TriggerPublic[] }>('GET', `${TRIGGERS_API}?source=${source}`);
    if (!res.ok) {
      setState(res.status === 403 ? { kind: 'forbidden' } : { kind: 'failed', error: res.error });
      return;
    }
    // Routines are listed by their own section, with their own editor.
    const triggers = res.data.triggers.filter((tr) => !excludeRoutines || tr.created_by !== 'routine');
    setState({ kind: 'ready', triggers });
  }, [source, excludeRoutines]);
  useEffect(() => {
    void reload();
    const id = setInterval(() => { void reload(); }, 10_000);
    return () => clearInterval(id);
  }, [reload]);
  return { state, reload };
}

/** Agent names for the task action: the agent is chosen here, never by a payload. */
function useAgentNames(): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void requestJson<{ agents?: { name: string }[] }>('GET', '/api/ui/agents').then((res) => {
      if (alive && res.ok) setNames((res.data.agents ?? []).map((a) => a.name));
    });
    return () => { alive = false; };
  }, []);
  return names;
}

const WORKFLOWS_MODULE = '@rooks/workflows';

/** Workflows the `workflow` action may start; null while the Workflows module is off. */
function useWorkflowChoices(): WorkflowChoice[] | null {
  const on = isModuleOn(useCapabilities(), WORKFLOWS_MODULE);
  const [list, setList] = useState<WorkflowChoice[]>([]);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void requestJson<{ workflows?: WorkflowChoice[] }>('GET', '/api/ui/workflows').then((res) => {
      if (alive && res.ok) setList((res.data.workflows ?? []).map((w) => ({ id: w.id, name: w.name, published_version: w.published_version })));
    });
    return () => { alive = false; };
  }, [on]);
  return on ? list : null;
}

function authOf(trigger: TriggerPublic): AuthScheme | null {
  return trigger.source === 'webhook' && trigger.config ? (trigger.config as WebhookConfig).auth : null;
}

type Shown = { secret: string; scheme: AuthScheme; url: string | null; outbound?: boolean };

export function TriggerList({ source, excludeRoutines = false }: { source: TriggerSource; excludeRoutines?: boolean }): React.ReactElement {
  const { state, reload } = useTriggers(source, excludeRoutines);
  const agents = useAgentNames();
  const workflows = useWorkflowChoices();
  const [editing, setEditing] = useState<TriggerPublic | 'new' | null>(null);
  // Creation may hand out two secrets (received / sent): shown one after the other.
  const [queue, setQueue] = useState<Shown[]>([]);
  const shown = queue[0] ?? null;
  const [testing, setTesting] = useState<TriggerPublic | null>(null);
  const [journal, setJournal] = useState<TriggerPublic | null>(null);

  function saved({ trigger, secret, outbound_secret: outboundSecret }: SavedTrigger) {
    setEditing(null);
    toast.success(t('triggersPage.saved'));
    const scheme = authOf(trigger);
    const next: Shown[] = [];
    if (secret && scheme) next.push({ secret, scheme, url: hookUrl(trigger, window.location.origin) });
    if (outboundSecret) next.push({ secret: outboundSecret, scheme: 'standard', url: null, outbound: true });
    if (next.length) setQueue(next);
    void reload();
  }

  async function rotateOutbound(trigger: TriggerPublic) {
    if (!(await confirmAction({ title: t('triggersPage.rotateOutboundConfirm', { name: trigger.name }), confirmLabel: t('confirmDialog.renew'), destructive: true }))) return;
    const res = await requestJson<SavedTrigger>('POST', triggerApi(trigger.id, 'outbound-secret'));
    if (!res.ok || !res.data.outbound_secret) { toast.error(res.ok ? t('triggersPage.rotateFailed') : res.error); return; }
    setQueue([{ secret: res.data.outbound_secret, scheme: 'standard', url: null, outbound: true }]);
  }

  async function rotate(trigger: TriggerPublic) {
    const scheme = authOf(trigger);
    if (!scheme || !(await confirmAction({ title: t('triggersPage.rotateConfirm', { name: trigger.name }), confirmLabel: t('confirmDialog.renew'), destructive: true }))) return;
    const res = await requestJson<SavedTrigger>('POST', triggerApi(trigger.id, 'secret'));
    if (!res.ok || !res.data.secret) { toast.error(res.ok ? t('triggersPage.rotateFailed') : res.error); return; }
    setQueue([{ secret: res.data.secret, scheme, url: hookUrl(trigger, window.location.origin) }]);
  }

  async function toggle(trigger: TriggerPublic) {
    const res = await requestJson('PATCH', triggerApi(trigger.id), { enabled: !trigger.enabled });
    if (res.ok) void reload(); else toast.error(res.error);
  }

  async function remove(trigger: TriggerPublic) {
    if (!(await confirmAction({ title: t('triggersPage.deleteConfirm', { name: trigger.name }), confirmLabel: t('confirmDialog.delete'), destructive: true }))) return;
    const res = await requestJson('DELETE', triggerApi(trigger.id));
    if (res.ok) { toast.success(t('triggersPage.deleted')); void reload(); } else toast.error(res.error);
  }

  function copyUrl(trigger: TriggerPublic) {
    const url = hookUrl(trigger, window.location.origin);
    if (!url) return;
    void copyWithToast(url, 'triggersPage.urlCopied');
  }

  if (state.kind === 'loading') return <p className="mt-3 text-[12px] text-muted-foreground">{t('triggersPage.loading')}</p>;
  if (state.kind === 'forbidden') return <p role="alert" className="mt-3 rounded-lg border border-dashed border-border p-4 text-[12px] text-muted-foreground">{t('triggersPage.forbidden')}</p>;
  if (state.kind === 'failed') return <p role="alert" className="mt-3 text-[12px] text-destructive">{t('triggersPage.loadFailed', { error: state.error })}</p>;

  const { triggers } = state;
  return (
    <div className="mt-3 space-y-2" data-testid={`trigger-list-${source}`}>
      {editing && (
        <TriggerEditor
          source={source} trigger={editing === 'new' ? null : editing} agents={agents} workflows={workflows}
          onClose={() => setEditing(null)} onSaved={saved}
        />
      )}
      {testing && <TestDialog trigger={testing} onClose={() => { setTesting(null); void reload(); }} />}
      {journal && <JournalDialog trigger={journal} onClose={() => setJournal(null)} />}
      {shown && <SecretDialog key={shown.secret} secret={shown.secret} scheme={shown.scheme} url={shown.url} outbound={shown.outbound} onClose={() => setQueue((q) => q.slice(1))} />}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => setEditing('new')} className="h-7 px-3 text-[12px]">{t(`triggersPage.new.${source}`)}</Button>
        <span className="text-[11.5px] text-muted-foreground">
          {t(triggers.length > 1 ? 'triggersPage.countOther' : 'triggersPage.countOne', { count: triggers.length })}
        </span>
      </div>
      {triggers.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-[12px] text-muted-foreground/70">
          {t(`triggersPage.empty.${source}`)}
        </div>
      )}
      {triggers.map((trigger) => (
        <article
          key={trigger.id}
          className={cn('group flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3', !trigger.enabled && 'opacity-60')}
        >
          <button
            type="button"
            onClick={() => toggle(trigger)}
            aria-label={t(trigger.enabled ? 'triggersPage.disable' : 'triggersPage.enable')}
            title={t(trigger.enabled ? 'triggersPage.disable' : 'triggersPage.enable')}
            className={cn(
              'h-2 w-2 flex-none rounded-full',
              trigger.enabled ? 'bg-[hsl(var(--success))] shadow-[0_0_0_3px_hsl(var(--success)/0.18)]' : 'bg-muted-foreground/40',
            )}
          />
          <div className="min-w-0 flex-1">
            <button type="button" onClick={() => setEditing(trigger)} className="text-left text-[13px] font-medium leading-snug hover:underline">
              {trigger.name}
            </button>
            {trigger.source === 'webhook' && trigger.url && (
              <div className="mt-0.5 flex items-center gap-1.5">
                {/* code-font: a webhook URL */}
                <code className="truncate font-mono text-[11px] text-muted-foreground">{trigger.url}</code>
                <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => copyUrl(trigger)} aria-label={t('triggersPage.copyUrl')}>
                  <Copy className="size-3" />
                </Button>
              </div>
            )}
          </div>
          <span className={CHIP}>{sourceChip(trigger)}</span>
          {(trigger.actions ?? []).map((action, index) => (
            <span key={index} className={CHIP}>{t(`triggersPage.actions.${action.type}`)}</span>
          ))}
          {trigger.creator_agent && <span className={CHIP}>{t('triggersPage.byAgent', { agent: trigger.creator_agent })}</span>}
          <div className="hidden flex-col items-end tabular-nums text-[10.5px] leading-tight text-muted-foreground/70 md:flex">
            {trigger.source === 'schedule' && <span>{t('routinesPage.next', { date: fmtDate(trigger.next_run_at) })}</span>}
            <span>{t('routinesPage.last', { date: fmtDate(trigger.last_run_at) })}</span>
          </div>
          <button type="button" onClick={() => setTesting(trigger)} className={cn(ROW_BUTTON, 'hover:border-primary hover:text-primary')}>
            {t('triggersPage.test.open')}
          </button>
          <button type="button" onClick={() => setJournal(trigger)} className={cn(ROW_BUTTON, 'hover:border-primary hover:text-primary')}>
            {t('triggersPage.journal.open')}
          </button>
          {authOf(trigger) && authOf(trigger) !== 'none' && (
            <button type="button" onClick={() => rotate(trigger)} className={cn(ROW_BUTTON, 'hover:border-primary hover:text-primary')}>
              {t('triggersPage.rotate')}
            </button>
          )}
          {(trigger.actions ?? []).some((action) => action.type === 'webhook') && (
            <button type="button" onClick={() => rotateOutbound(trigger)} className={cn(ROW_BUTTON, 'hover:border-primary hover:text-primary')}>
              {t('triggersPage.rotateOutbound')}
            </button>
          )}
          <button type="button" onClick={() => remove(trigger)} className={cn(ROW_BUTTON, 'hover:border-destructive hover:text-destructive')}>
            {t('triggersPage.delete')}
          </button>
        </article>
      ))}
    </div>
  );
}
