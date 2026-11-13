'use client';

/**
 * A trigger an agent asks for, because it runs a script (TODO #421): the shared
 * proposal card shows it whole — source, rhythm or event, then EVERY action —
 * so the click approves exactly what will run. The daemon creates it inside the
 * claim (`applyOnServer`); the browser writes nothing.
 */

import type { ReactElement } from 'react';
import { t } from '@/lib/i18n';
import type { ApplyResult, ProposalKindRenderer } from './layout-proposal-kinds';

export const TRIGGER_PROPOSAL_KIND = 'trigger';

type ScriptAction = {
  type: 'script'; command: string; args?: string[]; cwd: string; env?: string[];
  timeout_s?: number; overlap?: 'skip' | 'allow'; notify_on_failure?: boolean;
};
type ProposedAction = ScriptAction | ({ type: string } & Record<string, unknown>);
type ProposedTrigger = {
  name: string;
  source: 'schedule' | 'event';
  config: { cron?: string; tz?: string; event?: string };
  actions: ProposedAction[];
};

function parse(payload: unknown): ProposedTrigger | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Partial<ProposedTrigger>;
  if (typeof p.name !== 'string' || (p.source !== 'schedule' && p.source !== 'event')) return null;
  if (typeof p.config !== 'object' || p.config === null || !Array.isArray(p.actions)) return null;
  return p as ProposedTrigger;
}

function isScript(action: ProposedAction): action is ScriptAction {
  return action.type === 'script';
}

/** argv as a person would type it: an argument with a space or a quote is quoted. */
function commandLine(action: ScriptAction): string {
  const quote = (part: string) => (/[\s"'\\]/.test(part) || part === '' ? JSON.stringify(part) : part);
  return [action.command, ...(action.args ?? [])].map(quote).join(' ');
}

function ScriptDetails({ action }: { action: ScriptAction }): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      {/* code-font: the command line that will run */}
      <code className="whitespace-pre-wrap rounded bg-muted/50 px-2 py-1 font-mono text-[12px] [overflow-wrap:anywhere]">{commandLine(action)}</code>
      <span className="text-muted-foreground [overflow-wrap:anywhere]">{t('triggerProposal.cwd', { cwd: action.cwd })}</span>
      <span className="text-muted-foreground">
        {action.env?.length ? t('triggerProposal.secrets', { names: action.env.join(', ') }) : t('triggerProposal.noSecret')}
        {' · '}
        <span className="tabular-nums">{t('triggerProposal.timeout', { s: action.timeout_s ?? 300 })}</span>
        {action.overlap === 'allow' ? ` · ${t('triggerProposal.overlap')}` : ''}
        {action.notify_on_failure === false ? ` · ${t('triggerProposal.noAlert')}` : ''}
      </span>
    </div>
  );
}

function TriggerPreview({ payload }: { payload: unknown; titleOf: (id: string) => string }): ReactElement {
  const proposal = parse(payload);
  if (!proposal) return <p className="text-[12.5px] text-muted-foreground">{t('layoutProposal.unknownKind')}</p>;
  const when = proposal.source === 'schedule'
    ? t('triggerProposal.schedule', { cron: proposal.config.cron ?? '?', tz: proposal.config.tz ?? t('triggerProposal.localTime') })
    : t('triggerProposal.event', { event: proposal.config.event ?? '?' });
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <div className="flex flex-col">
        <span className="font-medium">{proposal.name}</span>
        <span className="text-muted-foreground">{when}</span>
      </div>
      <ol className="flex flex-col gap-2">
        {proposal.actions.map((action, index) => (
          <li key={index} className="flex flex-col gap-1">
            <span className="text-[12px] font-medium">{t(`triggersPage.actions.${action.type}`)}</span>
            {isScript(action)
              ? <ScriptDetails action={action} />
              // code-font: the raw action, as the daemon will store it
              : <pre className="whitespace-pre-wrap rounded bg-muted/50 px-2 py-1 font-mono text-[11px]">{JSON.stringify(action, null, 2)}</pre>}
          </li>
        ))}
      </ol>
      <p className="text-[11.5px] text-muted-foreground">{t('triggerProposal.warning')}</p>
    </div>
  );
}

/** The daemon created it while claiming the proposal: nothing left to write. */
async function applyTrigger(): Promise<ApplyResult> {
  return { ok: true, missing: [] };
}

export const TRIGGER_PROPOSAL_RENDERER: ProposalKindRenderer = {
  Preview: TriggerPreview,
  apply: applyTrigger,
  applyLabel: 'triggerProposal.approve',
  labels: {
    badge: 'triggerProposal.badge',
    title: 'triggerProposal.title',
    titleFrom: 'triggerProposal.titleFrom',
    applied: 'triggerProposal.applied',
    stateApplied: 'triggerProposal.stateApplied',
    dismiss: 'triggerProposal.reject',
    stale: 'triggerProposal.stale',
  },
};
