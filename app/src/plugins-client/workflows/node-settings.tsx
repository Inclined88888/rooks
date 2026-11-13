'use client';

/**
 * "Node settings" panel of the builder: label, per-type form (from the
 * presentation catalog), agent identity, trigger state, connections.
 *
 * No model, backend, tool or skill is listed here: everything comes from the
 * live catalogues (`/api/ui/backends/catalog`, `/api/ui/agents`,
 * `/api/ui/skills`, `/api/ui/mcp`) — PRD invariant §12.9.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronLeft, Copy, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SegControl } from '@/components/seg-control';
import { t } from '@/lib/i18n';
import { BrowserProfileSelect } from '@/components/browser-profile-select';
import { ModelPickerPopover, type ModelPick } from '@/components/model-picker';
import { useBackendCatalog, type BackendCatalog } from '@/lib/backends';
import { taskModelPick } from '@/lib/task-model-pick';
import { thinkingBarFor, thinkingValues } from '@/lib/thinking-bar';
import { cn } from '@/lib/utils';
import { CATEGORY_TONE, nodeTypeLabel, presentationFor, type FieldSpec } from './node-catalog';
import { formatRelative, outPortsFor, removeEdges, updateEdge, updateNode, type NodeType, type Workflow, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode, type WorkflowNativeTrigger, type WorkflowTrigger } from './types';

const CRON_PRESETS: { key: string; expr: string }[] = [
  { key: 'hourly', expr: '0 * * * *' },
  { key: 'daily', expr: '0 9 * * *' },
  { key: 'night', expr: '0 2 * * *' },
  { key: 'weekly', expr: '0 9 * * 1' },
  { key: 'monthly', expr: '0 9 1 * *' },
];

const INPUT = 'h-8 text-xs';
const SELECT = 'h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] font-medium text-muted-foreground">{label}</Label>
      {children}
      {hint && <p className="text-[10px] leading-snug text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

const FIELD_HINTS: Record<string, string> = {
  input: 'workflows.inputHint',
  routes: 'workflows.routesHint',
  completion: 'workflows.completionHint',
  headers: 'workflows.headersHint',
  allowPrivateNetwork: 'workflows.allowPrivateNetworkHint',
};

function fieldLabel(key: string): string {
  const label = t(`workflows.fields.${key}`);
  return label === `workflows.fields.${key}` ? key : label;
}

function FieldInput({ spec, value, onChange }: { spec: FieldSpec; value: unknown; onChange: (value: unknown) => void }) {
  const [jsonText, setJsonText] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [jsonError, setJsonError] = useState(false);
  useEffect(() => {
    if (spec.kind !== 'json') return;
    const next = value === undefined ? '' : JSON.stringify(value, null, 2);
    setJsonText((current) => {
      try { return JSON.stringify(JSON.parse(current)) === JSON.stringify(value) ? current : next; } catch { return current; }
    });
  }, [spec.kind, value]);

  switch (spec.kind) {
    case 'textarea':
      return <Textarea value={typeof value === 'string' ? value : ''} placeholder={spec.placeholder} onChange={(event) => onChange(event.target.value)} className="min-h-[88px] text-xs" />;
    case 'number':
      return <Input type="number" value={typeof value === 'number' ? value : ''} onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))} className={INPUT} />;
    case 'select':
      return (
        <select className={SELECT} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">—</option>
          {spec.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      );
    case 'boolean':
      return <Switch checked={value === true} onCheckedChange={(checked) => onChange(checked || undefined)} aria-label={fieldLabel(spec.key)} />;
    case 'list':
      // code-font: identifiers read verbatim by the node, comma-separated
      return <Input value={Array.isArray(value) ? (value as string[]).join(', ') : ''} placeholder={spec.placeholder} onChange={(event) => onChange(event.target.value.split(',').map((item) => item.trim()).filter(Boolean))} className={cn(INPUT, 'font-mono')} />;
    case 'cron':
      return (
        <div className="space-y-1.5">
          {/* code-font: a cron expression */}
          <Input value={typeof value === 'string' ? value : ''} placeholder="0 9 * * 1" onChange={(event) => onChange(event.target.value)} className={cn(INPUT, 'font-mono')} />
          <div className="flex flex-wrap gap-1">
            {CRON_PRESETS.map((preset) => (
              <button key={preset.key} type="button" onClick={() => onChange(preset.expr)} className={cn('rounded-md border px-1.5 py-0.5 text-[10px] transition-colors', value === preset.expr ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted')}>
                {t(`workflows.cron.${preset.key}`)}
              </button>
            ))}
          </div>
        </div>
      );
    case 'json':
      return (
        <div className="space-y-1">
          <Textarea
            value={jsonText}
            placeholder={spec.placeholder}
            // code-font: raw JSON
            className={cn('min-h-[72px] font-mono text-[11px]', jsonError && 'border-destructive')}
            onChange={(event) => {
              setJsonText(event.target.value);
              try { onChange(event.target.value.trim() ? JSON.parse(event.target.value) : undefined); setJsonError(false); } catch { setJsonError(true); }
            }}
          />
          {jsonError && <p className="text-[10px] text-destructive">{t('workflows.invalidJson')}</p>}
        </div>
      );
    default:
      // code-font: only for a field its node type declares as code (`spec.mono`)
      return <Input value={typeof value === 'string' ? value : ''} placeholder={spec.placeholder} onChange={(event) => onChange(event.target.value)} className={cn(INPUT, spec.mono && 'font-mono')} />;
  }
}

/* ── Chip multi-select on a live catalogue ───────────────────────────────── */

function ChipSelect({ options, value, onChange, empty }: { options: { id: string; label?: string }[]; value: string[]; onChange: (value: string[]) => void; empty: string }) {
  const [filter, setFilter] = useState('');
  const visible = useMemo(() => options.filter((option) => !filter || option.id.toLowerCase().includes(filter.toLowerCase()) || (option.label ?? '').toLowerCase().includes(filter.toLowerCase())), [filter, options]);
  if (options.length === 0) return <p className="text-[10.5px] text-muted-foreground/70">{empty}</p>;
  return (
    <div className="space-y-1.5">
      {options.length > 12 && <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t('workflows.filter')} className="h-7 text-[11px]" />}
      <div className="flex max-h-32 flex-wrap gap-1 overflow-auto">
        {visible.map((option) => {
          const on = value.includes(option.id);
          return (
            <button key={option.id} type="button" onClick={() => onChange(on ? value.filter((item) => item !== option.id) : [...value, option.id])} className={cn('max-w-full truncate rounded-md border px-1.5 py-0.5 text-[10px] transition-colors', on ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted')} title={option.label ?? option.id}>
              {option.label?.trim() || option.id.replace(/^(@timon\/|timon-)/, '')}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Agent identity ──────────────────────────────────────────────────────── */

type Catalogues = { agents: { name: string; project?: string | null }[]; skills: { id: string; name?: string }[]; mcp: { id: string; name?: string }[] };
let cataloguesCache: Catalogues | null = null;

function useCatalogues(): Catalogues {
  const [value, setValue] = useState<Catalogues>(cataloguesCache ?? { agents: [], skills: [], mcp: [] });
  useEffect(() => {
    if (cataloguesCache) return;
    let cancelled = false;
    void (async () => {
      const read = async (url: string) => { try { const response = await fetch(url, { cache: 'no-store' }); return response.ok ? await response.json() as Record<string, unknown> : {}; } catch { return {}; } };
      const [agents, skills, mcp] = await Promise.all([read('/api/ui/agents'), read('/api/ui/skills'), read('/api/ui/mcp')]);
      const next: Catalogues = {
        agents: Array.isArray(agents.agents) ? (agents.agents as { name: string; project?: string | null }[]) : [],
        skills: Array.isArray(skills.skills) ? (skills.skills as { id: string; name?: string }[]) : [],
        mcp: Array.isArray(mcp.servers) ? (mcp.servers as { id: string; name?: string }[]) : [],
      };
      cataloguesCache = next;
      if (!cancelled) setValue(next);
    })();
    return () => { cancelled = true; };
  }, []);
  return value;
}

/**
 * What a pick writes on an agent node: both halves, or none for "inherit"
 * (the referenced agent's pair, else the pilot's). The thinking setting
 * follows the model: kept when the new model knows it, dropped otherwise.
 */
export function nodeModelPatch(catalog: BackendCatalog, effort: unknown, next: ModelPick | null): Record<string, unknown> {
  if (!next) return { backend: undefined, model: undefined, reasoningEffort: undefined };
  const kept = typeof effort === 'string' && thinkingValues(thinkingBarFor(catalog, next.backend, next.model)).includes(effort);
  return { backend: next.backend, model: next.model, reasoningEffort: kept ? effort : undefined };
}

function AgentIdentity({ config, onChange }: { config: Record<string, unknown>; onChange: (config: Record<string, unknown>) => void }) {
  const catalog = useBackendCatalog();
  const catalogues = useCatalogues();
  const identity = (config.identity && typeof config.identity === 'object' ? config.identity : {}) as Record<string, unknown>;
  const mode: 'ref' | 'inline' = typeof config.ref === 'string' && config.ref ? 'ref' : config.identity ? 'inline' : 'ref';
  const backend = typeof config.backend === 'string' && config.backend ? config.backend : '';
  const model = typeof config.model === 'string' ? config.model : '';
  // Same reading as a task's overrides: both empty is "inherit", a half-pair
  // written by the old two selects shows what it runs and stays stored as is
  // until a pick.
  const pick = taskModelPick(catalog, backend, model);
  const thinkingBar = thinkingBarFor(catalog, backend || catalog.defaultBackend, model);
  const set = useCallback((patch: Record<string, unknown>) => onChange({ ...config, ...patch }), [config, onChange]);
  const setIdentity = useCallback((patch: Record<string, unknown>) => onChange({ ...config, identity: { ...identity, ...patch } }), [config, identity, onChange]);
  const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

  return (
    <div className="space-y-3">
      <SegControl
        className="w-full"
        value={mode}
        items={[{ value: 'ref', label: t('workflows.identityRef') }, { value: 'inline', label: t('workflows.identityInline') }]}
        onChange={(next) => {
          if (next === 'ref') { const rest = { ...config }; delete rest.identity; onChange({ ...rest, ref: typeof config.ref === 'string' && config.ref ? config.ref : catalogues.agents[0]?.name ?? '' }); }
          else { const rest = { ...config }; delete rest.ref; onChange({ ...rest, identity: { name: '', instructions: '', ...identity } }); }
        }}
      />
      {mode === 'ref' ? (
        <Field label={t('workflows.agentRef')} hint={t('workflows.agentRefHint')}>
          <select className={SELECT} value={typeof config.ref === 'string' ? config.ref : ''} onChange={(event) => set({ ref: event.target.value })}>
            <option value="">—</option>
            {catalogues.agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
          </select>
        </Field>
      ) : (
        <>
          <Field label={t('workflows.fields.name')}>
            <Input value={typeof identity.name === 'string' ? identity.name : ''} onChange={(event) => setIdentity({ name: event.target.value })} className={INPUT} />
          </Field>
          <Field label={t('workflows.instructions')} hint={t('workflows.instructionsHint')}>
            <Textarea value={typeof identity.instructions === 'string' ? identity.instructions : ''} onChange={(event) => setIdentity({ instructions: event.target.value })} className="min-h-[120px] text-xs" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('workflows.fields.project')}><Input value={typeof identity.project === 'string' ? identity.project : ''} onChange={(event) => setIdentity({ project: event.target.value || undefined })} className={INPUT} /></Field>
            {/* code-font: a filesystem path */}
            <Field label={t('workflows.fields.cwd')}><Input value={typeof identity.cwd === 'string' ? identity.cwd : ''} onChange={(event) => setIdentity({ cwd: event.target.value || undefined })} className={cn(INPUT, 'font-mono')} /></Field>
          </div>
        </>
      )}
      <Field label={t('workflows.model')}>
        <ModelPickerPopover
          value={pick}
          onChange={(next) => set(nodeModelPatch(catalog, config.reasoningEffort, next))}
          target={mode === 'ref'
            ? { agent: typeof config.ref === 'string' ? config.ref : null, project: catalogues.agents.find((a) => a.name === config.ref)?.project }
            : { project: typeof identity.project === 'string' ? identity.project : null }}
          inherit={{ label: t('workflows.inherit'), hint: t(mode === 'ref' ? 'workflows.modelInheritRef' : 'workflows.modelInheritPilot') }}
          label={t('workflows.model')}
          triggerClassName="w-full"
        />
      </Field>
      {thinkingBar && (
        <Field label={t('workflows.reasoning')}>
          <select className={SELECT} value={typeof config.reasoningEffort === 'string' ? config.reasoningEffort : ''} onChange={(event) => set({ reasoningEffort: event.target.value || undefined })}>
            <option value="">{t('workflows.inherit')}</option>
            {thinkingBar.stops.map((stop) => <option key={stop.value} value={stop.value}>{stop.label}</option>)}
          </select>
        </Field>
      )}
      <Field label={t('workflows.permissionMode')}>
        <Input value={typeof config.permissionMode === 'string' ? config.permissionMode : ''} placeholder={t('workflows.inherit')} onChange={(event) => set({ permissionMode: event.target.value || undefined })} className={INPUT} />
      </Field>
      <Field label={t('browserPanel.native.profile')}>
        <BrowserProfileSelect value={config.browserProfileId === null ? null : typeof config.browserProfileId === 'string' ? config.browserProfileId : undefined} onChange={(browserProfileId) => set({ browserProfileId })} />
      </Field>
      <Field label={t('workflows.skills')}>
        <ChipSelect options={catalogues.skills.map((skill) => ({ id: skill.id, label: skill.name }))} value={strList(config.skills)} onChange={(skills) => set({ skills })} empty={t('workflows.noCatalogue')} />
      </Field>
      <Field label={t('workflows.mcpServers')}>
        <ChipSelect options={catalogues.mcp.map((server) => ({ id: server.id, label: server.name }))} value={strList(config.mcpServers)} onChange={(mcpServers) => set({ mcpServers })} empty={t('workflows.noCatalogue')} />
      </Field>
      <Field label={t('workflows.allowedTools')} hint={t('workflows.allowedToolsHint')}>
        {/* code-font: tool patterns such as mcp__notes__*, read by the CLI as typed */}
        <Input value={strList(config.allowedTools).join(', ')} placeholder="Read, Bash, mcp__notes__*" onChange={(event) => set({ allowedTools: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} className={cn(INPUT, 'font-mono')} />
      </Field>
    </div>
  );
}

/* ── Trigger state (the native trigger behind a façade node) ─────────────── */

/** Entry nodes a native trigger may start (`trigger.business` belongs to a plugin). */
const NATIVE_ENTRY_TYPES = ['trigger.manual', 'trigger.schedule', 'trigger.webhook', 'trigger.event'];
/** Nodes published as one native trigger each (schedule, webhook, event). */
const FACADE_TYPES = ['trigger.schedule', 'trigger.webhook', 'trigger.event'];
const NATIVE_TAB: Record<string, string> = { schedule: 'routines', webhook: 'webhooks', event: 'events' };

/** Other native triggers (Triggers page) whose `workflow` action starts this node. */
function NativeTriggers({ native }: { native: readonly WorkflowNativeTrigger[] }) {
  if (!native.length) {
    return <p className="text-[10px] text-muted-foreground/70">{t('workflows.nativeNone')} <a href="/triggers" className="underline">{t('workflows.nativeOpen')}</a></p>;
  }
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-muted-foreground">{t('workflows.nativeStartedBy')}</p>
      <ul className="space-y-0.5">
        {native.map((item) => (
          <li key={item.trigger_id} className="flex items-center gap-1.5 text-[11px]">
            <a href={`/triggers?tab=${NATIVE_TAB[item.source] ?? 'routines'}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{item.name}</a>
            <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{item.source}</span>
            {!item.enabled && <span className="text-[10px] text-muted-foreground">{t('workflows.nativeDisabled')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value);
  toast.success(t('workflows.copied'));
}

/** The native trigger a published façade node owns: route, secret rotation, next run, link to the Triggers page. */
function FacadeTriggerState({ trigger }: { trigger: WorkflowTrigger | null }) {
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => { setSecret(null); }, [trigger?.trigger_id]);
  if (!trigger) return <p className="rounded-md border border-dashed border-border px-2 py-1.5 text-[10.5px] text-muted-foreground">{t('workflows.triggerNotArmed')}</p>;
  const rotate = async () => {
    const response = await fetch(`/api/ui/triggers/${encodeURIComponent(trigger.trigger_id)}/secret`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const value = await response.json().catch(() => ({})) as { secret?: unknown };
    if (!response.ok || typeof value.secret !== 'string') { toast.error(t('workflows.secretError')); return; }
    setSecret(value.secret);
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <a href={`/triggers?tab=${NATIVE_TAB[trigger.source] ?? 'routines'}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{trigger.name}</a>
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{trigger.source}</span>
        {!trigger.enabled && <span className="text-[10px] text-muted-foreground">{t('workflows.nativeDisabled')}</span>}
      </div>
      {trigger.url && (
        <div className="flex items-center gap-1">
          {/* code-font: the hook URL to copy */}
          <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1 font-mono text-[10px]">{trigger.url}</code>
          <Button variant="ghost" size="sm" className="h-7 px-2" title={t('workflows.copied')} onClick={() => copyText(new URL(trigger.url!, window.location.origin).href)}><Copy className="size-3.5" /></Button>
          {trigger.has_secret && <Button variant="ghost" size="sm" className="h-7 px-2" title={t('workflows.regenerateSecret')} onClick={() => void rotate()}><RefreshCw className="size-3.5" /></Button>}
        </div>
      )}
      {secret && (
        <div className="space-y-1 rounded-md bg-[hsl(var(--warning)/0.12)] p-2">
          <p className="text-[10px] text-muted-foreground">{t('workflows.secretShownOnce')}</p>
          <div className="flex items-center gap-1">
            {/* code-font: the signing secret to copy */}
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1 font-mono text-[10px]">{secret}</code>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => copyText(secret)}><Copy className="size-3.5" /></Button>
          </div>
        </div>
      )}
      {trigger.url && <p className="text-[10px] text-muted-foreground/70">{t('workflows.webhookHint')}</p>}
      <dl className="grid grid-cols-2 gap-1 text-[11px]">
        {trigger.source === 'schedule' && <><dt className="text-muted-foreground">{t('workflows.nextRun')}</dt><dd className="tabular-nums">{trigger.next_run_at ? formatRelative(trigger.next_run_at) : '—'}</dd></>}
        <dt className="text-muted-foreground">{t('workflows.lastRun')}</dt><dd className="tabular-nums">{trigger.last_run_at ? formatRelative(trigger.last_run_at) : '—'}</dd>
      </dl>
      <p className="text-[10px] text-muted-foreground/70">{t('workflows.triggerNativeHint')}</p>
    </div>
  );
}

function TriggerState({ workflow, node }: { workflow: Workflow; node: WorkflowNode }) {
  const [trigger, setTrigger] = useState<WorkflowTrigger | null>(null);
  const [native, setNative] = useState<WorkflowNativeTrigger[]>([]);
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/ui/workflows/${workflow.id}/triggers`, { cache: 'no-store' });
      if (!response.ok) return;
      const value = await response.json() as { triggers?: WorkflowTrigger[]; native?: WorkflowNativeTrigger[] };
      const own = value.triggers?.find((item) => item.node_id === node.id) ?? null;
      setTrigger(own);
      // The façade's own trigger is drawn above; the list keeps the user's.
      setNative((value.native ?? []).filter((item) => item.node_id === node.id && item.trigger_id !== own?.trigger_id));
    } catch { /* the panel simply shows "not armed" */ }
  }, [node.id, workflow.id]);
  useEffect(() => { void load(); }, [load, workflow.published_version, workflow.enabled]);

  return (
    <div className="space-y-2">
      {FACADE_TYPES.includes(node.type) && <FacadeTriggerState trigger={trigger} />}
      {NATIVE_ENTRY_TYPES.includes(node.type) && <NativeTriggers native={native} />}
    </div>
  );
}

/* ── Connections ─────────────────────────────────────────────────────────── */

function EdgeRow({ edge, definition, direction, onChange, onFocus }: { edge: WorkflowEdge; definition: WorkflowDefinition; direction: 'in' | 'out'; onChange: (definition: WorkflowDefinition) => void; onFocus: (id: string) => void }) {
  const other = definition.nodes.find((node) => node.id === (direction === 'in' ? edge.from : edge.to));
  return (
    <div className="rounded-md border border-border/70 bg-background/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        {direction === 'out' && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{edge.fromPort}</span>}
        <ArrowRight className="size-3 text-muted-foreground" />
        <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => onFocus(other?.id ?? '')}>{other?.label || other?.id || '?'}</button>
        {direction === 'in' && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{edge.fromPort}</span>}
        <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => onChange(removeEdges(definition, [edge.id]))} title={t('workflows.removeEdge')}><Trash2 className="size-3" /></button>
      </div>
      {/* code-font: a condition expression */}
      <Input value={edge.condition ?? ''} placeholder={t('workflows.conditionPlaceholder')} onChange={(event) => onChange(updateEdge(definition, edge.id, { condition: event.target.value || null }))} className="mt-1 h-6 font-mono text-[10px]" />
    </div>
  );
}

/* ── Panel ───────────────────────────────────────────────────────────────── */

export function NodeSettings({ workflow, definition, node, nodeTypes, onChange, onBack, onFocusNode }: {
  workflow: Workflow;
  definition: WorkflowDefinition;
  node: WorkflowNode;
  nodeTypes: NodeType[];
  onChange: (definition: WorkflowDefinition) => void;
  onBack: () => void;
  onFocusNode: (id: string) => void;
}) {
  const pres = presentationFor(node.type);
  const Icon = pres.icon;
  const tone = CATEGORY_TONE[pres.category];
  const spec = nodeTypes.find((item) => item.type === node.type);
  const ports = outPortsFor(node, spec);
  const incoming = definition.edges.filter((edge) => edge.to === node.id);
  const outgoing = definition.edges.filter((edge) => edge.from === node.id);
  const setConfig = useCallback((config: Record<string, unknown>) => onChange(updateNode(definition, node.id, { config })), [definition, node.id, onChange]);
  const setField = useCallback((key: string, value: unknown) => {
    const config = { ...node.config };
    if (value === undefined || value === '') delete config[key]; else config[key] = value;
    setConfig(config);
  }, [node.config, setConfig]);
  const isAgent = node.type === 'agent' || node.type === 'skill';
  const isTrigger = node.type.startsWith('trigger.');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 px-3 py-2">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onBack} title={t('workflows.add')}><ChevronLeft className="size-4" /></Button>
        <span className="flex size-6 items-center justify-center rounded-md" style={{ background: `color-mix(in srgb, ${tone} 18%, transparent)` }}><Icon className="size-3.5" style={{ color: tone }} /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold">{nodeTypeLabel(node.type)}</div>
          {/* code-font: the node id that edge conditions and ports refer to */}
          <div className="truncate font-mono text-[10px] text-muted-foreground">{node.id}</div>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => onChange({ ...definition, nodes: definition.nodes.filter((item) => item.id !== node.id), edges: definition.edges.filter((edge) => edge.from !== node.id && edge.to !== node.id) })} title={t('workflows.deleteNode')}><Trash2 className="size-3.5" /></Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3">
        <Field label={t('workflows.label')}>
          <Input value={node.label ?? ''} onChange={(event) => onChange(updateNode(definition, node.id, { label: event.target.value }))} className={INPUT} />
        </Field>
        {isAgent && <AgentIdentity config={node.config} onChange={setConfig} />}
        {pres.fields.length > 0 && (
          <div className="space-y-3">
            {isAgent && <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('workflows.execution')}</h4>}
            {pres.fields.map((field) => (
              <Field key={field.key} label={fieldLabel(field.key)} hint={FIELD_HINTS[field.key] ? t(FIELD_HINTS[field.key]!) : undefined}>
                <FieldInput spec={field} value={node.config[field.key]} onChange={(value) => setField(field.key, value)} />
              </Field>
            ))}
          </div>
        )}
        {isTrigger && (
          <div className="space-y-1.5">
            <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('workflows.triggerState')}</h4>
            <TriggerState workflow={workflow} node={node} />
          </div>
        )}
        <div className="space-y-1.5">
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('workflows.connections')}</h4>
          {incoming.length === 0 && outgoing.length === 0 && <p className="text-[10.5px] text-muted-foreground/70">{t('workflows.noConnections')}</p>}
          {incoming.length > 0 && <p className="text-[10px] text-muted-foreground">{t('workflows.incoming')}</p>}
          {incoming.map((edge) => <EdgeRow key={edge.id} edge={edge} definition={definition} direction="in" onChange={onChange} onFocus={onFocusNode} />)}
          {outgoing.length > 0 && <p className="text-[10px] text-muted-foreground">{t('workflows.outgoing')}</p>}
          {outgoing.map((edge) => <EdgeRow key={edge.id} edge={edge} definition={definition} direction="out" onChange={onChange} onFocus={onFocusNode} />)}
          {ports.length > 0 && (
            <p className="text-[10px] text-muted-foreground/70">{t('workflows.ports')}: <span>{ports.join(' · ')}</span></p>
          )}
        </div>
      </div>
    </div>
  );
}
