'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { CRON_PRESETS } from '../routines/routines-page';
import { requestJson, triggerApi, TRIGGERS_API } from './api';
import { TriggerModal, TriggerModalTitle } from './modal';
import {
  ACTION_TYPES, AUTH_SCHEMES, EVENT_KINDS, EVENT_VARIABLES, FILTER_OPS, MAX_ACTIONS, SCHEDULE_VARIABLES, TASK_TYPES, URGENCIES,
  draftFromTrigger, draftToBody, emptyAction, emptyCondition, slugify,
  type ActionDraft, type ActionType, type AuthScheme, type ConditionDraft, type DraftProblem, type EventKind, type FilterDraft,
  type FilterOp, type TriggerDraft, type TriggerPublic, type TriggerSource,
} from './model';

export const INPUT = 'w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary';
const SELECT = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary';
const LABEL = 'mb-1 block text-[11px] text-muted-foreground';
const HINT = 'mt-1 text-[11px] leading-relaxed text-muted-foreground';
const STEPS = ['source', 'filter', 'action'] as const;

export type SavedTrigger = { trigger: TriggerPublic; secret?: string; outbound_secret?: string };

/** A workflow the `workflow` action may start; `null` list = the Workflows module is off. */
export type WorkflowChoice = { id: string; name: string; published_version: number | null };
type EntryNode = { id: string; type: string; label: string | null };

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: React.ReactNode; hint?: string }): React.ReactElement {
  return (
    <div>
      <label htmlFor={htmlFor} className={LABEL}>{label}</label>
      {children}
      {hint && <p className={HINT}>{hint}</p>}
    </div>
  );
}

function SourceStep({ draft, set, editing, slugTouched, onSlug }: {
  draft: TriggerDraft;
  set: (patch: Partial<TriggerDraft>) => void;
  editing: boolean;
  slugTouched: boolean;
  onSlug: (slug: string) => void;
}): React.ReactElement {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return (
    <div className="space-y-3">
      <Field label={t('triggersPage.editor.name')} htmlFor="trigger-name">
        <input
          id="trigger-name" autoFocus value={draft.name} className={INPUT}
          placeholder={t(`triggersPage.editor.namePlaceholder.${draft.source}`)}
          onChange={(e) => set({ name: e.target.value, ...(draft.source === 'webhook' && !editing && !slugTouched ? { slug: slugify(e.target.value) } : {}) })}
        />
      </Field>

      {draft.source === 'schedule' && (
        <>
          <Field label={t('triggersPage.editor.cron')} htmlFor="trigger-cron">
            {/* code-font: a cron expression */}
            <input id="trigger-cron" value={draft.cron} onChange={(e) => set({ cron: e.target.value })} className={cn(INPUT, 'font-mono')} placeholder="0 9 * * *" />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.expr} type="button" onClick={() => set({ cron: preset.expr })}
                  className="rounded-md border border-border bg-muted/30 px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground"
                >
                  {t(preset.labelKey)}
                </button>
              ))}
            </div>
          </Field>
          <Field label={t('triggersPage.editor.tz')} htmlFor="trigger-tz" hint={t('triggersPage.editor.tzHint')}>
            <input id="trigger-tz" value={draft.tz} onChange={(e) => set({ tz: e.target.value })} className={INPUT} placeholder="Europe/Paris" />
          </Field>
        </>
      )}

      {draft.source === 'webhook' && (
        <>
          <Field label={t('triggersPage.editor.slug')} htmlFor="trigger-slug" hint={t('triggersPage.editor.slugHint')}>
            {/* code-font: the webhook slug and the URL it builds */}
            <input id="trigger-slug" value={draft.slug} onChange={(e) => onSlug(e.target.value)} className={cn(INPUT, 'font-mono')} placeholder="github-issues" />
            <code className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{`${origin}/api/triggers/hooks/${draft.slug || '…'}`}</code>
          </Field>
          <Field label={t('triggersPage.editor.auth')} htmlFor="trigger-auth" hint={t(`triggersPage.editor.authHint.${draft.auth}`)}>
            <select id="trigger-auth" value={draft.auth} onChange={(e) => set({ auth: e.target.value as AuthScheme })} className={SELECT}>
              {AUTH_SCHEMES.map((scheme) => <option key={scheme} value={scheme}>{t(`triggersPage.auth.${scheme}`)}</option>)}
            </select>
          </Field>
        </>
      )}

      {draft.source === 'event' && (
        <Field label={t('triggersPage.editor.event')} htmlFor="trigger-event">
          <select id="trigger-event" value={draft.event} onChange={(e) => set({ event: e.target.value as EventKind })} className={SELECT}>
            {EVENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(`triggersPage.events.${kind}`)}</option>)}
          </select>
        </Field>
      )}

      {draft.source !== 'schedule' && (
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="cursor-pointer text-[12px] text-muted-foreground">{t('triggersPage.editor.advanced')}</summary>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label={t('triggersPage.editor.rateLimit')} htmlFor="trigger-rate">
              <input id="trigger-rate" inputMode="numeric" value={draft.rateLimit} onChange={(e) => set({ rateLimit: e.target.value })} className={INPUT} placeholder="30" />
            </Field>
            <div />
            <Field label={t('triggersPage.editor.coalesceKey')} htmlFor="trigger-coalesce-key">
              {/* code-font: a path into the payload */}
              <input id="trigger-coalesce-key" value={draft.coalesceKey} onChange={(e) => set({ coalesceKey: e.target.value })} className={cn(INPUT, 'font-mono')} placeholder="pull_request.number" />
            </Field>
            <Field label={t('triggersPage.editor.coalesceQuiet')} htmlFor="trigger-coalesce-quiet">
              <input id="trigger-coalesce-quiet" inputMode="decimal" value={draft.coalesceQuietS} onChange={(e) => set({ coalesceQuietS: e.target.value })} className={INPUT} placeholder="60" />
            </Field>
            <div />
            <Field label={t('triggersPage.editor.coalesceMax')} htmlFor="trigger-coalesce-max">
              <input id="trigger-coalesce-max" inputMode="decimal" value={draft.coalesceMaxS} onChange={(e) => set({ coalesceMaxS: e.target.value })} className={INPUT} />
            </Field>
          </div>
          <p className={HINT}>{t('triggersPage.editor.coalesceHint')}</p>
        </details>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        {t('triggersPage.editor.enabled')}
      </label>
    </div>
  );
}

function ConditionRow({ condition, index, onChange, onRemove }: {
  condition: ConditionDraft;
  index: number;
  onChange: (next: ConditionDraft) => void;
  onRemove: (() => void) | null;
}): React.ReactElement {
  const needsValue = condition.op !== 'exists' && condition.op !== 'missing';
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="filter-condition">
      <input
        aria-label={t('triggersPage.editor.conditionPath', { n: index + 1 })}
        value={condition.path} onChange={(e) => onChange({ ...condition, path: e.target.value })}
        // code-font: a path into the payload
        className={cn(INPUT, 'w-44 flex-none font-mono text-xs')} placeholder="action"
      />
      <select
        aria-label={t('triggersPage.editor.conditionOp', { n: index + 1 })}
        value={condition.op} onChange={(e) => onChange({ ...condition, op: e.target.value as FilterOp })}
        className={cn(SELECT, 'w-36 flex-none')}
      >
        {FILTER_OPS.map((op) => <option key={op} value={op}>{t(`triggersPage.editor.ops.${op}`)}</option>)}
      </select>
      {needsValue && (
        <input
          aria-label={t('triggersPage.editor.conditionValue', { n: index + 1 })}
          value={condition.value} onChange={(e) => onChange({ ...condition, value: e.target.value })}
          className={cn(INPUT, 'min-w-32 flex-1 text-xs')}
          placeholder={condition.op === 'in' ? 'opened, reopened' : condition.op === 'regex' ? '^bug' : 'opened'}
        />
      )}
      {condition.op === 'regex' && (
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={condition.caseInsensitive} onChange={(e) => onChange({ ...condition, caseInsensitive: e.target.checked })} />
          {t('triggersPage.editor.caseInsensitive')}
        </label>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={t('triggersPage.editor.removeCondition', { n: index + 1 })} className="text-muted-foreground hover:text-destructive">✕</button>
      )}
    </div>
  );
}

function FilterStep({ draft, source, set }: {
  draft: FilterDraft;
  source: TriggerSource;
  set: (filter: FilterDraft) => void;
}): React.ReactElement {
  if (source === 'schedule') return <p className="text-[12px] text-muted-foreground">{t('triggersPage.editor.noFilterForSchedule')}</p>;
  const conditions = draft.conditions.length ? draft.conditions : [emptyCondition()];
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={t('triggersPage.editor.filterMode')} className="flex flex-wrap gap-3 text-sm">
        {(['none', 'simple', 'json'] as const).map((mode) => (
          <label key={mode} className="flex items-center gap-1.5">
            <input type="radio" name="trigger-filter-mode" checked={draft.mode === mode} onChange={() => set({ ...draft, mode })} />
            {t(`triggersPage.editor.filterModes.${mode}`)}
          </label>
        ))}
      </div>
      {draft.mode === 'simple' && (
        <>
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <label htmlFor="trigger-combine">{t('triggersPage.editor.combine')}</label>
            <select id="trigger-combine" value={draft.combine} onChange={(e) => set({ ...draft, combine: e.target.value === 'any' ? 'any' : 'all' })} className={cn(SELECT, 'w-auto')}>
              <option value="all">{t('triggersPage.editor.combineAll')}</option>
              <option value="any">{t('triggersPage.editor.combineAny')}</option>
            </select>
          </div>
          {conditions.map((condition, index) => (
            <ConditionRow
              key={index} condition={condition} index={index}
              onChange={(next) => set({ ...draft, conditions: conditions.map((c, i) => (i === index ? next : c)) })}
              onRemove={conditions.length > 1 ? () => set({ ...draft, conditions: conditions.filter((_, i) => i !== index) }) : null}
            />
          ))}
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => set({ ...draft, conditions: [...conditions, emptyCondition()] })}>
            {t('triggersPage.editor.addCondition')}
          </Button>
          <p className={HINT}>{t('triggersPage.editor.pathHint')}</p>
        </>
      )}
      {draft.mode === 'json' && (
        <Field label={t('triggersPage.editor.filterJson')} htmlFor="trigger-filter-json" hint={t('triggersPage.editor.filterJsonHint')}>
          {/* code-font: a JSON filter */}
          <textarea id="trigger-filter-json" rows={8} value={draft.json} onChange={(e) => set({ ...draft, json: e.target.value })} className={cn(INPUT, 'font-mono text-xs')} spellCheck={false} />
        </Field>
      )}
      {draft.mode !== 'none' && <p className={HINT}>{t('triggersPage.editor.filterIgnored')}</p>}
    </div>
  );
}

/** Entry nodes of the workflow's published version — the one a trigger starts. */
function useEntryNodes(workflowId: string): EntryNode[] | null {
  const [nodes, setNodes] = useState<EntryNode[] | null>(null);
  useEffect(() => {
    if (!workflowId) { setNodes(null); return; }
    let alive = true;
    void requestJson<{ nodes?: EntryNode[] }>('GET', `/api/ui/workflows/${encodeURIComponent(workflowId)}/entry-nodes`).then((res) => {
      if (alive) setNodes(res.ok ? res.data.nodes ?? [] : []);
    });
    return () => { alive = false; };
  }, [workflowId]);
  return nodes;
}

function WorkflowFields({ action, workflows, id, set }: {
  action: ActionDraft;
  workflows: readonly WorkflowChoice[];
  id: (name: string) => string;
  set: (patch: Partial<ActionDraft>) => void;
}): React.ReactElement {
  const nodes = useEntryNodes(action.workflow);
  const known = workflows.some((w) => w.id === action.workflow);
  const knownNode = nodes?.some((n) => n.id === action.node) ?? false;
  return (
    <>
      <Field label={t('triggersPage.editor.workflow')} htmlFor={id('workflow')} hint={t('triggersPage.editor.workflowHint')}>
        <select id={id('workflow')} value={action.workflow} onChange={(e) => set({ workflow: e.target.value, node: '' })} className={SELECT}>
          <option value="">—</option>
          {workflows.map((w) => (
            <option key={w.id} value={w.id} disabled={!w.published_version}>
              {w.published_version ? w.name : t('triggersPage.editor.workflowUnpublished', { name: w.name })}
            </option>
          ))}
          {action.workflow && !known && <option value={action.workflow}>{action.workflow}</option>}
        </select>
      </Field>
      {action.workflow && (
        <Field label={t('triggersPage.editor.workflowNode')} htmlFor={id('node')} hint={nodes && nodes.length === 0 ? t('triggersPage.editor.workflowNoEntry') : undefined}>
          <select id={id('node')} value={action.node} onChange={(e) => set({ node: e.target.value })} className={SELECT}>
            <option value="">—</option>
            {(nodes ?? []).map((n) => <option key={n.id} value={n.id}>{n.label ? `${n.label} (${n.id})` : n.id}</option>)}
            {action.node && !knownNode && <option value={action.node}>{action.node}</option>}
          </select>
        </Field>
      )}
    </>
  );
}

function ActionCard({ action, index, agents, workflows, onChange, onRemove }: {
  action: ActionDraft;
  index: number;
  agents: readonly string[];
  workflows: readonly WorkflowChoice[] | null;
  onChange: (next: ActionDraft) => void;
  onRemove: (() => void) | null;
}): React.ReactElement {
  const id = (name: string) => `trigger-action-${index}-${name}`;
  const set = (patch: Partial<ActionDraft>) => onChange({ ...action, ...patch });
  // Offered only while Workflows runs; an action saved before stays shown.
  const types = ACTION_TYPES.filter((type) => type !== 'workflow' || workflows !== null || action.type === 'workflow');
  return (
    <fieldset className="space-y-3 rounded-lg border border-border p-3" data-testid="trigger-action">
      <legend className="sr-only">{t('triggersPage.editor.actionN', { n: index + 1 })}</legend>
      <div className="flex items-center gap-2">
        <select
          aria-label={t('triggersPage.editor.actionType', { n: index + 1 })}
          value={action.type}
          onChange={(e) => onChange({ ...emptyAction(e.target.value as ActionType, agents[0] ?? ''), type: e.target.value as ActionType })}
          className={cn(SELECT, 'w-auto')}
        >
          {types.map((type) => <option key={type} value={type}>{t(`triggersPage.actions.${type}`)}</option>)}
        </select>
        <span className="flex-1" />
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-[11px] text-muted-foreground hover:text-destructive">{t('triggersPage.editor.removeAction')}</button>
        )}
      </div>

      {action.type === 'todo' && (
        <>
          <Field label={t('triggersPage.editor.todoText')} htmlFor={id('text')}>
            <input id={id('text')} value={action.text} onChange={(e) => set({ text: e.target.value })} className={INPUT} placeholder="Bug: {issue.title}" />
          </Field>
          <Field label={t('triggersPage.editor.todoNotes')} htmlFor={id('notes')}>
            <textarea id={id('notes')} rows={2} value={action.notes} onChange={(e) => set({ notes: e.target.value })} className={INPUT} placeholder="{issue.body}" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('triggersPage.editor.project')} htmlFor={id('project')}>
              <input id={id('project')} value={action.project} onChange={(e) => set({ project: e.target.value })} className={cn(INPUT, 'text-xs')} placeholder="timon" />
            </Field>
            <Field label={t('triggersPage.editor.urgency')} htmlFor={id('urgency')} hint={t('triggersPage.editor.urgencyHint', { list: URGENCIES.join(', ') })}>
              <input id={id('urgency')} value={action.urgency} onChange={(e) => set({ urgency: e.target.value })} className={cn(INPUT, 'text-xs')} placeholder="bug" />
            </Field>
          </div>
        </>
      )}

      {action.type === 'task' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('triggersPage.editor.agent')} htmlFor={id('agent')} hint={t('triggersPage.editor.agentHint')}>
              <select id={id('agent')} value={action.agent} onChange={(e) => set({ agent: e.target.value })} className={SELECT}>
                <option value="">—</option>
                {[...new Set([...agents, ...(action.agent ? [action.agent] : [])])].map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </Field>
            <Field label={t('triggersPage.editor.taskType')} htmlFor={id('type')}>
              <select id={id('type')} value={action.taskType} onChange={(e) => set({ taskType: e.target.value })} className={SELECT}>
                {TASK_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </Field>
          </div>
          <Field label={t('triggersPage.editor.taskTitle')} htmlFor={id('title')}>
            <input id={id('title')} value={action.title} onChange={(e) => set({ title: e.target.value })} className={INPUT} placeholder="Triage {issue.title}" />
          </Field>
          <Field label={t('triggersPage.editor.taskPrompt')} htmlFor={id('prompt')} hint={action.raw ? t('triggersPage.editor.rawPrompt') : undefined}>
            <textarea id={id('prompt')} rows={3} value={action.prompt} onChange={(e) => set({ prompt: e.target.value })} className={INPUT} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('triggersPage.editor.project')} htmlFor={id('project')}>
              <input id={id('project')} value={action.project} onChange={(e) => set({ project: e.target.value })} className={cn(INPUT, 'text-xs')} placeholder="timon" />
            </Field>
            <Field label={t('triggersPage.editor.priority')} htmlFor={id('priority')}>
              <select id={id('priority')} value={action.priority} onChange={(e) => set({ priority: e.target.value })} className={SELECT}>
                <option value="">—</option>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n}</option>)}
              </select>
            </Field>
          </div>
          <label className="flex items-start gap-1.5 text-sm">
            <input type="checkbox" className="mt-0.5" checked={action.silentReturn} onChange={(e) => set({ silentReturn: e.target.checked })} />
            <span>
              {t('triggersPage.editor.silentReturn')}
              <span className={cn(HINT, 'block')}>{t('triggersPage.editor.silentReturnHint')}</span>
            </span>
          </label>
        </>
      )}

      {action.type === 'notify' && (
        <>
          <Field label={t('triggersPage.editor.notifyTitle')} htmlFor={id('ntitle')}>
            <input id={id('ntitle')} value={action.notifyTitle} onChange={(e) => set({ notifyTitle: e.target.value })} className={INPUT} placeholder="{task.title} is blocked" />
          </Field>
          <Field label={t('triggersPage.editor.notifyBody')} htmlFor={id('nbody')}>
            <textarea id={id('nbody')} rows={2} value={action.body} onChange={(e) => set({ body: e.target.value })} className={INPUT} />
          </Field>
          <div className="flex items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" name={id('level')} checked={action.level === 'report'} onChange={() => set({ level: 'report' })} />
              {t('triggersPage.editor.levelReport')}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name={id('level')} checked={action.level === 'alert'} onChange={() => set({ level: 'alert' })} />
              {t('triggersPage.editor.levelAlert')}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={action.urgent} onChange={(e) => set({ urgent: e.target.checked })} />
              {t('triggersPage.editor.urgent')}
            </label>
          </div>
        </>
      )}

      {action.type === 'workflow' && (
        workflows === null
          ? <p role="note" className={HINT}>{t('triggersPage.editor.workflowsOff')}</p>
          : <WorkflowFields action={action} workflows={workflows} id={id} set={set} />
      )}

      {action.type === 'webhook' && (
        <Field label={t('triggersPage.editor.webhookUrl')} htmlFor={id('url')} hint={t('triggersPage.editor.webhookHint')}>
          {/* code-font: a URL */}
          <input id={id('url')} type="url" value={action.url} onChange={(e) => set({ url: e.target.value })} className={cn(INPUT, 'font-mono text-xs')} placeholder="https://example.com/hooks/timon" />
        </Field>
      )}

      {action.type === 'script' && (
        <>
          <p role="note" className={HINT}>{t('triggersPage.editor.scriptNote')}</p>
          <Field label={t('triggersPage.editor.scriptCommand')} htmlFor={id('command')} hint={t('triggersPage.editor.scriptCommandHint')}>
            {/* code-font: a command line */}
            <input id={id('command')} value={action.command} onChange={(e) => set({ command: e.target.value })} className={cn(INPUT, 'font-mono text-xs')} placeholder="python3" />
          </Field>
          <Field label={t('triggersPage.editor.scriptArgs')} htmlFor={id('args')} hint={t('triggersPage.editor.scriptArgsHint')}>
            {/* code-font: command-line arguments */}
            <textarea id={id('args')} rows={2} value={action.scriptArgs} onChange={(e) => set({ scriptArgs: e.target.value })} className={cn(INPUT, 'font-mono text-xs')} placeholder={'scripts/watch.py\npoll'} />
          </Field>
          <Field label={t('triggersPage.editor.scriptCwd')} htmlFor={id('cwd')} hint={t('triggersPage.editor.scriptCwdHint')}>
            <input id={id('cwd')} value={action.cwd} onChange={(e) => set({ cwd: e.target.value })} className={INPUT} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('triggersPage.editor.scriptEnv')} htmlFor={id('env')} hint={t('triggersPage.editor.scriptEnvHint')}>
              <input id={id('env')} value={action.scriptEnv} onChange={(e) => set({ scriptEnv: e.target.value })} className={INPUT} placeholder="TREG_API_KEY" />
            </Field>
            <Field label={t('triggersPage.editor.scriptTimeout')} htmlFor={id('timeout')}>
              <input id={id('timeout')} inputMode="numeric" value={action.timeoutS} onChange={(e) => set({ timeoutS: e.target.value })} className={cn(INPUT, 'tabular-nums')} placeholder="300" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={action.notifyOnFailure} onChange={(e) => set({ notifyOnFailure: e.target.checked })} />
              {t('triggersPage.editor.scriptNotify')}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={action.allowOverlap} onChange={(e) => set({ allowOverlap: e.target.checked })} />
              {t('triggersPage.editor.scriptOverlap')}
            </label>
          </div>
        </>
      )}
    </fieldset>
  );
}

function ActionStep({ draft, agents, workflows, set }: {
  draft: TriggerDraft;
  agents: readonly string[];
  workflows: readonly WorkflowChoice[] | null;
  set: (actions: ActionDraft[]) => void;
}): React.ReactElement {
  const variables = draft.source === 'schedule' ? SCHEDULE_VARIABLES : draft.source === 'event' ? EVENT_VARIABLES[draft.event] : [];
  return (
    <div className="space-y-3">
      <p className={HINT}>
        {t('triggersPage.editor.templateHint')}
        {/* code-font: template variables */}
        {variables.length > 0 && <> {t('triggersPage.editor.variables')} <code className="font-mono">{variables.join(' ')}</code></>}
      </p>
      {draft.source !== 'schedule' && <p className={HINT}>{t('triggersPage.editor.untrusted')}</p>}
      {draft.actions.map((action, index) => (
        <ActionCard
          key={index} action={action} index={index} agents={agents} workflows={workflows}
          onChange={(next) => set(draft.actions.map((a, i) => (i === index ? next : a)))}
          onRemove={draft.actions.length > 1 ? () => set(draft.actions.filter((_, i) => i !== index)) : null}
        />
      ))}
      {draft.actions.length < MAX_ACTIONS && (
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => set([...draft.actions, emptyAction('todo', agents[0] ?? '')])}>
          {t('triggersPage.editor.addAction')}
        </Button>
      )}
    </div>
  );
}

/**
 * Creation and edition of a trigger in three steps: source → filter →
 * action. The source is fixed once created (the daemon refuses to move it).
 */
export function TriggerEditor({ source, trigger, agents, workflows = null, onClose, onSaved }: {
  source: TriggerSource;
  trigger: TriggerPublic | null;
  agents: readonly string[];
  workflows?: readonly WorkflowChoice[] | null;
  onClose: () => void;
  onSaved: (saved: SavedTrigger) => void;
}): React.ReactElement {
  const editing = trigger !== null;
  const [initial] = useState<TriggerDraft>(() => draftFromTrigger(trigger, source, agents[0] ?? ''));
  const [draft, setDraft] = useState<TriggerDraft>(initial);
  const [step, setStep] = useState(0);
  const [slugTouched, setSlugTouched] = useState(editing);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Escape on a modified draft asks first: a reflex keystroke must not throw
  // away a filter and actions built over three steps. The explicit ✕ and
  // Cancel still close at once — that is what they say.
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const resumeFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (confirmingDiscard) return;
    const field = resumeFocus.current;
    resumeFocus.current = null;
    if (field?.isConnected) field.focus();
  }, [confirmingDiscard]);

  function escapeRefused() {
    // A second Escape answers the question the safe way.
    if (confirmingDiscard) { setConfirmingDiscard(false); return; }
    resumeFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmingDiscard(true);
  }

  const set = (patch: Partial<TriggerDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setProblem(null);
    // Typing again is an answer too; focus is already where the user wants it.
    resumeFocus.current = null;
    setConfirmingDiscard(false);
  };

  function check(upTo: number): boolean {
    const built = draftToBody(draft);
    if (!built.ok && built.problem.step <= upTo) {
      setProblem(built.problem);
      setStep(built.problem.step);
      return false;
    }
    return true;
  }

  async function save() {
    const built = draftToBody(draft);
    if (!built.ok) { setProblem(built.problem); setStep(built.problem.step); return; }
    setSaving(true);
    setServerError(null);
    const { source: _source, ...patch } = built.body;
    const res = editing
      ? await requestJson<SavedTrigger>('PATCH', triggerApi(trigger.id), patch)
      : await requestJson<SavedTrigger>('POST', TRIGGERS_API, built.body);
    setSaving(false);
    if (!res.ok) { setServerError(res.error); return; }
    onSaved(res.data);
  }

  const last = step === STEPS.length - 1;
  return (
    <TriggerModal onClose={onClose} escapeCloses={!dirty} onEscapeRefused={escapeRefused}>
      <form
        onSubmit={(e) => { e.preventDefault(); if (last) void save(); else if (check(step)) setStep(step + 1); }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="mb-3 flex items-center justify-between">
          <TriggerModalTitle testId="trigger-editor-title">
            {t(editing ? 'triggersPage.editor.editTitle' : 'triggersPage.editor.newTitle', { source: t(`triggersPage.sources.${draft.source}`) })}
          </TriggerModalTitle>
          <button type="button" onClick={onClose} aria-label={t('routinesPage.close')} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>

        <ol className="mb-4 flex gap-2 text-[11.5px]">
          {STEPS.map((name, index) => (
            <li key={name}>
              <button
                type="button"
                aria-current={index === step ? 'step' : undefined}
                onClick={() => { if (index <= step || check(index - 1)) setStep(index); }}
                className={cn(
                  'rounded-full border px-2.5 py-0.5',
                  index === step ? 'border-primary text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {t('triggersPage.editor.stepN', { n: index + 1, label: t(`triggersPage.editor.steps.${name}`) })}
              </button>
            </li>
          ))}
        </ol>

        <div className="min-h-0 flex-1 overflow-auto pr-1">
          {step === 0 && (
            <SourceStep
              draft={draft} set={set} editing={editing} slugTouched={slugTouched}
              onSlug={(slug) => { setSlugTouched(true); set({ slug: slug.toLowerCase() }); }}
            />
          )}
          {step === 1 && <FilterStep draft={draft.filter} source={draft.source} set={(filter) => set({ filter })} />}
          {step === 2 && <ActionStep draft={draft} agents={agents} workflows={workflows} set={(actions) => set({ actions })} />}
        </div>

        {problem && <p role="alert" className="mt-3 text-[12px] text-destructive">{t(problem.key, problem.vars)}</p>}
        {serverError && <p role="alert" className="mt-3 text-[12px] text-destructive">{t('triggersPage.editor.refused', { error: serverError })}</p>}

        {confirmingDiscard ? (
          <div data-testid="trigger-editor-discard" className="mt-4 flex items-center justify-end gap-2">
            <p role="alert" className="mr-auto text-[12px] text-foreground">{t('triggersPage.editor.discardPrompt')}</p>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('triggersPage.editor.discard')}</Button>
            <Button type="button" size="sm" autoFocus onClick={() => setConfirmingDiscard(false)}>{t('triggersPage.editor.keepEditing')}</Button>
          </div>
        ) : (
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={step === 0 ? onClose : () => setStep(step - 1)}>
              {t(step === 0 ? 'routinesPage.cancel' : 'triggersPage.editor.back')}
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {t(last ? (saving ? 'routinesPage.saving' : editing ? 'routinesPage.save' : 'triggersPage.editor.create') : 'triggersPage.editor.next')}
            </Button>
          </div>
        )}
      </form>
    </TriggerModal>
  );
}
