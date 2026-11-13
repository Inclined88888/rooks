'use client';

/**
 * Builder page (`/workflows/[slug]`, PRD §8.2): palette or node settings on
 * the left, the canvas in the middle, the chat with the workflow's orchestrator on
 * the right.
 *
 * The draft is saved on a debounce; publish and run flush it first so the
 * daemon never freezes a version older than what the screen shows.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Braces,
  Check,
  CircleAlert,
  History,
  LoaderCircle,
  Play,
  Redo2,
  Rocket,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  WandSparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ArchitectChat } from './architect-chat';
import { WorkflowWorkspace } from './workspace';
import { defaultConfig, defaultLabel } from './node-catalog';
import { NodePalette } from './palette';
import { NodeSettings } from './node-settings';
import { BrowserProfileSelect } from '@/components/browser-profile-select';
import { RunStatusBadge } from './trace-panel';
import { WorkflowCanvas, type CanvasSelection } from './workflow-canvas';
import {
  MAX_LOOP_ITERATIONS,
  formatDuration,
  formatRelative,
  formatTokens,
  newNodeId,
  parseDefinition,
  removeEdges,
  runDuration,
  safeJson,
  sameJson,
  tidyDefinition,
  updateEdge,
  type NodeType,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowRun,
  type WorkflowVariable,
} from './types';

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

export function useWorkflow(slug: string) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [nodeTypes, setNodeTypes] = useState<NodeType[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  useEffect(() => {
    if (!slug) { setWorkflow(null); setStatus('missing'); return; }
    let cancelled = false;
    void (async () => {
      setStatus('loading');
      try {
        const [wfRes, typesRes] = await Promise.all([
          fetch(`/api/ui/workflows/${encodeURIComponent(slug)}`, { cache: 'no-store' }),
          fetch('/api/ui/workflows/node-types', { cache: 'no-store' }),
        ]);
        const body = await readJson(wfRes);
        const registry = await readJson(typesRes);
        if (cancelled) return;
        const found = body.workflow && typeof body.workflow === 'object' ? body.workflow as Workflow : null;
        setWorkflow(found);
        setNodeTypes(Array.isArray(registry.nodeTypes) ? (registry.nodeTypes as NodeType[]) : []);
        setStatus(wfRes.status === 404 ? 'missing' : !wfRes.ok || !found ? 'error' : 'ready');
      } catch {
        if (!cancelled) { setWorkflow(null); setStatus('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);
  return { workflow, nodeTypes, setWorkflow, status };
}

function SaveIndicator({ state, error }: { state: SaveState; error: string | null }) {
  if (state === 'idle') return null;
  const map: Record<Exclude<SaveState, 'idle'>, { icon: React.ReactNode; label: string; className: string }> = {
    dirty: { icon: <span className="size-1.5 rounded-full bg-[hsl(var(--warning))]" />, label: t('workflows.save.dirty'), className: 'text-muted-foreground' },
    saving: { icon: <LoaderCircle className="size-3 animate-spin" />, label: t('workflows.save.saving'), className: 'text-muted-foreground' },
    saved: { icon: <Check className="size-3" />, label: t('workflows.save.saved'), className: 'text-[hsl(var(--success))]' },
    error: { icon: <CircleAlert className="size-3" />, label: t('workflows.save.error'), className: 'text-destructive' },
  };
  const item = map[state];
  // The reason stays reachable on hover: a toast is gone in four seconds, the
  // banner is what one still sees when wondering why nothing is saved.
  return <span className={cn('inline-flex items-center gap-1 text-[10.5px]', item.className)} title={state === 'error' ? error ?? undefined : undefined}>{item.icon}{item.label}</span>;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function EdgeSettings({ definition, edgeId, onChange, onBack }: { definition: WorkflowDefinition; edgeId: string; onChange: (definition: WorkflowDefinition) => void; onBack: () => void }) {
  const edge = definition.edges.find((item) => item.id === edgeId);
  if (!edge) return null;
  const from = definition.nodes.find((node) => node.id === edge.from);
  const to = definition.nodes.find((node) => node.id === edge.to);
  return (
    <div className="space-y-3 px-3 py-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onBack}><ArrowLeft className="size-4" /></Button>
        <div className="min-w-0 flex-1 text-[12.5px] font-semibold">{t('workflows.edge')}</div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => { onChange(removeEdges(definition, [edge.id])); onBack(); }}><Trash2 className="size-3.5" /></Button>
      </div>
      <div className="rounded-md border border-border/70 bg-background/40 px-2 py-1.5 text-[11px]">
        <span className="font-medium">{from?.label || from?.id}</span>
        <span className="mx-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">{edge.fromPort}</span>
        → <span className="font-medium">{to?.label || to?.id}</span>
      </div>
      <div className="space-y-1">
        <Label className="text-[11px] font-medium text-muted-foreground">{t('workflows.condition')}</Label>
        {/* code-font: a condition expression */}
        <Input value={edge.condition ?? ''} placeholder={t('workflows.conditionPlaceholder')} onChange={(event) => onChange(updateEdge(definition, edge.id, { condition: event.target.value || null }))} className="h-8 font-mono text-xs" />
        <p className="text-[10px] text-muted-foreground/70">{t('workflows.conditionHint')}</p>
      </div>
      <div className="flex items-center justify-between rounded-md border border-border/70 px-2 py-1.5">
        <div>
          <div className="text-[11px] font-medium">{t('workflows.loopEdge')}</div>
          <div className="text-[10px] text-muted-foreground/70">{t('workflows.loopHint')}</div>
        </div>
        <Switch checked={!!edge.loop} onCheckedChange={(loop) => onChange(updateEdge(definition, edge.id, { loop, maxIterations: loop ? edge.maxIterations ?? 3 : undefined }))} />
      </div>
      {edge.loop && (
        <div className="space-y-1">
          <Label className="text-[11px] font-medium text-muted-foreground">{t('workflows.maxIterations')}</Label>
          <Input type="number" min={1} max={MAX_LOOP_ITERATIONS} value={edge.maxIterations ?? 3} onChange={(event) => onChange(updateEdge(definition, edge.id, { maxIterations: Math.min(MAX_LOOP_ITERATIONS, Math.max(1, Number(event.target.value) || 1)) }))} className="h-8 text-xs" />
        </div>
      )}
    </div>
  );
}

const VARIABLE_TYPES: WorkflowVariable['type'][] = ['string', 'number', 'boolean', 'json'];

function parseDefault(type: WorkflowVariable['type'], raw: string): unknown {
  if (raw === '') return undefined;
  if (type === 'number') return Number(raw);
  if (type === 'boolean') return raw === 'true';
  if (type === 'json') { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
}

function VariablesDialog({ open, definition, onChange, onClose }: { open: boolean; definition: WorkflowDefinition; onChange: (definition: WorkflowDefinition) => void; onClose: () => void }) {
  const variables = definition.variables;
  const set = (next: WorkflowVariable[]) => onChange({ ...definition, variables: next });
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('workflows.variables')}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">{t('workflows.variablesHint')}</p>
        <div className="space-y-2">
          {variables.length === 0 && <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{t('workflows.noVariables')}</p>}
          {variables.map((variable, index) => (
            <div key={index} className="grid grid-cols-[1fr_92px_1fr_28px] items-center gap-2">
              {/* code-font: a variable name and its typed default */}
              <Input value={variable.name} placeholder="name" className="h-8 font-mono text-xs" onChange={(event) => set(variables.map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))} />
              <select className="h-8 rounded-md border border-input bg-background px-2 text-xs" value={variable.type} onChange={(event) => set(variables.map((item, i) => (i === index ? { ...item, type: event.target.value as WorkflowVariable['type'] } : item)))}>
                {VARIABLE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              {/* code-font: a default value, JSON for objects and lists */}
              <Input value={variable.default === undefined ? '' : typeof variable.default === 'string' ? variable.default : JSON.stringify(variable.default)} placeholder={t('workflows.fields.default')} className="h-8 font-mono text-xs" onChange={(event) => set(variables.map((item, i) => (i === index ? { ...item, default: parseDefault(item.type, event.target.value) } : item)))} />
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => set(variables.filter((_, i) => i !== index))}><X className="size-3.5" /></Button>
            </div>
          ))}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="outline" size="sm" onClick={() => set([...variables, { name: `var${variables.length + 1}`, type: 'string' }])}>{t('workflows.addVariable')}</Button>
          <Button size="sm" onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog({ open, workflow, definition, onChange, onWorkflow, onClose, onDelete }: { open: boolean; workflow: Workflow; definition: WorkflowDefinition; onChange: (definition: WorkflowDefinition) => void; onWorkflow: (workflow: Workflow) => void; onClose: () => void; onDelete: () => void }) {
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? '');
  const [agent, setAgent] = useState(workflow.agent_name ?? '');
  const [agents, setAgents] = useState<{ name: string }[]>([]);
  useEffect(() => { if (open) { setName(workflow.name); setDescription(workflow.description ?? ''); setAgent(workflow.agent_name ?? ''); } }, [open, workflow.agent_name, workflow.description, workflow.name]);
  // The pilot is chosen among the live agents, never typed.
  useEffect(() => {
    if (!open) return;
    void fetch('/api/ui/agents', { cache: 'no-store' }).then(readJson).then((value) => {
      setAgents(Array.isArray(value.agents) ? (value.agents as { name: string }[]).filter((item) => typeof item.name === 'string') : []);
    }).catch(() => setAgents([]));
  }, [open]);
  const settings = definition.settings;
  const setSetting = (key: keyof WorkflowDefinition['settings'], value: unknown) => {
    const next = { ...settings } as Record<string, unknown>;
    if (value === undefined || value === '') delete next[key]; else next[key] = value;
    onChange({ ...definition, settings: next as WorkflowDefinition['settings'] });
  };
  const save = async () => {
    const trimmed = name.trim();
    const agentChanged = agent !== '' && agent !== (workflow.agent_name ?? '');
    if (trimmed !== workflow.name || (description || null) !== workflow.description || agentChanged) {
      const response = await fetch(`/api/ui/workflows/${workflow.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: trimmed || workflow.name, description, ...(agentChanged ? { agent_name: agent } : {}) }) });
      const value = await readJson(response);
      if (response.ok && value.workflow) onWorkflow({ ...workflow, ...(value.workflow as Workflow) });
      else { toast.error(typeof value.error === 'string' ? value.error : t(agentChanged ? 'workflows.agentSaveError' : 'workflows.save.error')); return; }
    }
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{t('workflows.settings')}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label className="text-xs">{t('workflows.name')}</Label><Input value={name} onChange={(event) => setName(event.target.value)} className="h-8 text-xs" /></div>
          <div className="space-y-1"><Label className="text-xs">{t('workflows.fields.description')}</Label><Textarea value={description} onChange={(event) => setDescription(event.target.value)} className="min-h-[64px] text-xs" /></div>
          <div className="space-y-1">
            <Label className="text-xs">{t('workflows.agent')}</Label>
            <select className={cn('h-8 w-full rounded-md border border-input bg-background px-2 text-xs', !agent && 'border-destructive')} value={agent} onChange={(event) => setAgent(event.target.value)}>
              {!agent && <option value="">{t('workflows.noAgent')}</option>}
              {agents.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
            <p className="text-[10.5px] text-muted-foreground/80">{t('workflows.agentHint')}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label className="text-xs">{t('workflows.settingsKeys.maxParallel')}</Label><Input type="number" min={1} value={settings.maxParallel ?? 3} onChange={(event) => setSetting('maxParallel', Math.max(1, Number(event.target.value) || 1))} className="h-8 text-xs" /></div>
            <div className="space-y-1"><Label className="text-xs">{t('workflows.settingsKeys.onError')}</Label>
              <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={settings.onError ?? 'fail'} onChange={(event) => setSetting('onError', event.target.value)}>
                <option value="fail">fail</option><option value="continue">continue</option>
              </select>
            </div>
            <div className="space-y-1"><Label className="text-xs">{t('workflows.settingsKeys.overlap')}</Label>
              <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={settings.overlap ?? 'skip'} onChange={(event) => setSetting('overlap', event.target.value)}>
                <option value="skip">skip</option><option value="queue">queue</option><option value="parallel">parallel</option>
              </select>
            </div>
            <div className="space-y-1"><Label className="text-xs">{t('workflows.settingsKeys.timeoutMs')}</Label><Input type="number" min={0} value={settings.timeoutMs ?? ''} onChange={(event) => setSetting('timeoutMs', event.target.value === '' ? undefined : Number(event.target.value))} className="h-8 text-xs" /></div>
            <div className="space-y-1"><Label className="text-xs">{t('workflows.settingsKeys.maxCostUsd')}</Label><Input type="number" min={0} step="0.01" value={settings.maxCostUsd ?? ''} onChange={(event) => setSetting('maxCostUsd', event.target.value === '' ? undefined : Number(event.target.value))} className="h-8 text-xs" /></div>
          </div>
          <div className="space-y-1"><Label className="text-xs">{t('browserPanel.native.profile')}</Label><BrowserProfileSelect value={settings.browserProfileId} onChange={(value) => setSetting('browserProfileId', value)} /></div>
          <p className="text-[10.5px] text-muted-foreground/80">{t('workflows.settingsHint')}</p>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}><Trash2 className="mr-1 size-3.5" />{t('workflows.deleteWorkflow')}</Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={() => void save()}>{t('common.save')}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunsSheet({ open, workflow, slug, onClose, onRun }: { open: boolean; workflow: Workflow; slug: string; onClose: () => void; onRun: () => void }) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void fetch(`/api/ui/workflows/${workflow.id}/runs`, { cache: 'no-store' }).then(readJson).then((value) => {
      if (!cancelled) setRuns(Array.isArray(value.runs) ? (value.runs as WorkflowRun[]) : []);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, workflow.id]);
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent className="flex w-[420px] flex-col gap-0 p-0 sm:max-w-[420px]">
        <SheetHeader className="px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="text-sm">{t('workflows.runs')}</SheetTitle>
            <Button size="sm" disabled={!workflow.published_version || !workflow.agent_name} title={!workflow.agent_name ? t('workflows.runNeedsAgent') : !workflow.published_version ? t('workflows.runNeedsPublish') : undefined} onClick={onRun}><Play className="mr-1 size-3.5" />{workflow.published_version ? t('workflows.runVersion', { n: workflow.published_version }) : t('workflows.neverPublished')}</Button>
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {loading && runs.length === 0 && <p className="p-4 text-center text-xs text-muted-foreground">{t('common.loading')}</p>}
          {!loading && runs.length === 0 && <p className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">{t('workflows.noRuns')}</p>}
          <ul className="space-y-1.5">
            {runs.map((run) => {
              const trigger = safeJson(run.trigger) as { kind?: string } | null;
              return (
                <li key={run.id}>
                  <Link href={`/workflows/${slug}/runs/${run.id}`} className="block rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:border-primary/50">
                    <div className="flex items-center gap-2">
                      <RunStatusBadge status={run.status} />
                      <span className="text-[10px] tabular-nums text-muted-foreground">v{run.version}</span>
                      {trigger?.kind && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{trigger.kind}</span>}
                      <span className="ml-auto text-[10.5px] text-muted-foreground">{formatRelative(run.started_at)}</span>
                    </div>
                    <div className="mt-1 flex gap-3 text-[10px] tabular-nums text-muted-foreground">
                      <span>{formatDuration(runDuration(run))}</span>
                      <span>{formatTokens((run.tokens_in ?? 0) + (run.tokens_out ?? 0))} tok</span>
                      {run.cost_usd ? <span>${run.cost_usd.toFixed(3)}</span> : null}
                      {run.error && <span className="truncate text-destructive">{run.error}</span>}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── Builder ─────────────────────────────────────────────────────────────── */

export function WorkflowBuilder({ slug }: { slug: string }) {
  const router = useRouter();
  const { workflow, nodeTypes, setWorkflow, status } = useWorkflow(slug);
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [rightOpen, setRightOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'variables' | 'settings' | 'delete'>(null);
  const [runsOpen, setRunsOpen] = useState(false);
  const [busy, setBusy] = useState<null | 'publish' | 'run'>(null);
  // What the daemon refused at the last publish or run, per node; cleared by the next edit.
  const [issues, setIssues] = useState<WorkflowIssue[] | null>(null);
  const history = useRef<WorkflowDefinition[]>([]);
  const future = useRef<WorkflowDefinition[]>([]);
  const loaded = useRef(false);
  const dirty = useRef(false);
  const lastError = useRef<string | null>(null);
  const latest = useRef<WorkflowDefinition | null>(null);
  latest.current = definition;

  useEffect(() => {
    if (!workflow || loaded.current) return;
    setDefinition(parseDefinition(workflow.draft));
    loaded.current = true;
    setFitKey((key) => key + 1);
  }, [workflow]);

  const update = useCallback((next: WorkflowDefinition) => {
    const previous = latest.current;
    if (!previous || sameJson(previous, next)) return;
    history.current.push(previous);
    if (history.current.length > 100) history.current.shift();
    future.current = [];
    dirty.current = true;
    setDefinition(next);
    setSaveState('dirty');
    setIssues(null);
  }, []);

  const saveNow = useCallback(async (): Promise<boolean> => {
    const current = latest.current;
    if (!workflow || !current || !dirty.current) return true;
    setSaveState('saving');
    try {
      const response = await fetch(`/api/ui/workflows/${workflow.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: current }) });
      const value = await readJson(response);
      if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : t('workflows.save.error'));
      dirty.current = false;
      setSaveState('saved');
      setSaveError(null);
      lastError.current = null;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : t('workflows.save.error');
      setSaveState('error');
      setSaveError(message);
      // The debounce retries on the next keystroke: toasting each time would
      // stack a wall of identical banners over the canvas.
      if (lastError.current !== message) toast.error(message);
      lastError.current = message;
      return false;
    }
  }, [workflow]);

  useEffect(() => {
    if (!definition || !dirty.current) return;
    const timer = setTimeout(() => { void saveNow(); }, 600);
    return () => clearTimeout(timer);
  }, [definition, saveNow]);

  const undo = useCallback(() => {
    const current = latest.current;
    const previous = history.current.pop();
    if (!current || !previous) return;
    future.current.push(current);
    dirty.current = true;
    setDefinition(previous);
    setSaveState('dirty');
  }, []);
  const redo = useCallback(() => {
    const current = latest.current;
    const next = future.current.pop();
    if (!current || !next) return;
    history.current.push(current);
    dirty.current = true;
    setDefinition(next);
    setSaveState('dirty');
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [redo, undo]);

  const addNode = useCallback((type: string, position?: { x: number; y: number }) => {
    const current = latest.current;
    if (!current) return;
    const id = newNodeId(type, current);
    const anchor = current.nodes.find((node) => selection?.kind === 'node' && node.id === selection.id) ?? current.nodes[current.nodes.length - 1];
    // Stack downward in the open canvas. A step to the right lands under the chat.
    const spot = position ?? { x: anchor?.position?.x ?? 80, y: (anchor?.position?.y ?? 80) + (anchor ? 160 : 0) };
    update({ ...current, nodes: [...current.nodes, { id, type, label: defaultLabel(type), position: spot, config: defaultConfig(type) }] });
    setSelection({ kind: 'node', id });
  }, [selection, update]);

  const publish = useCallback(async () => {
    if (!workflow) return;
    setBusy('publish');
    try {
      if (!(await saveNow())) return;
      const response = await fetch(`/api/ui/workflows/${workflow.id}/publish`, { method: 'POST' });
      const value = await readJson(response);
      if (!response.ok) { setIssues(Array.isArray(value.issues) ? (value.issues as WorkflowIssue[]) : null); toast.error(typeof value.error === 'string' ? value.error : t('workflows.publishError')); return; }
      setIssues(null);
      const version = typeof value.version === 'number' ? value.version : (workflow.published_version ?? 0) + 1;
      setWorkflow({ ...workflow, published_version: version });
      toast.success(t('workflows.published', { n: version }));
    } finally { setBusy(null); }
  }, [saveNow, setWorkflow, workflow]);

  const run = useCallback(async (draft: boolean) => {
    if (!workflow) return;
    setBusy('run');
    try {
      if (draft && !(await saveNow())) return;
      const response = await fetch(`/api/ui/workflows/${workflow.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft }) });
      const value = await readJson(response);
      const created = value.run as { id?: string } | undefined;
      if (!response.ok || !created?.id) { setIssues(Array.isArray(value.issues) ? (value.issues as WorkflowIssue[]) : null); toast.error(typeof value.error === 'string' ? value.error : t('workflows.runError')); return; }
      setIssues(null);
      router.push(`/workflows/${encodeURIComponent(slug)}/runs/${created.id}`);
    } finally { setBusy(null); }
  }, [router, saveNow, slug, workflow]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!workflow) return;
    setWorkflow({ ...workflow, enabled: enabled ? 1 : 0 });
    const response = await fetch(`/api/ui/workflows/${workflow.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
    if (!response.ok) { setWorkflow({ ...workflow }); toast.error(t('workflows.save.error')); }
  }, [setWorkflow, workflow]);

  const remove = useCallback(async () => {
    if (!workflow) return;
    const response = await fetch(`/api/ui/workflows/${workflow.id}`, { method: 'DELETE' });
    if (!response.ok) { toast.error(t('workflows.deleteError')); return; }
    router.push('/workflows');
  }, [router, workflow]);

  const onSelect = useCallback((next: CanvasSelection) => setSelection((current) => (sameJson(current, next) ? current : next)), []);
  const clearSelection = useCallback(() => setSelection(null), []);
  const focusNode = useCallback((id: string) => { if (id) setSelection({ kind: 'node', id }); }, []);
  const tidy = useCallback(() => { const current = latest.current; if (current) { update(tidyDefinition(current)); setFitKey((key) => key + 1); } }, [update]);

  const selectedNode = useMemo(() => (selection?.kind === 'node' ? definition?.nodes.find((node) => node.id === selection.id) ?? null : null), [definition, selection]);
  const issueByNode = useMemo(() => {
    if (!issues) return undefined;
    const map: Record<string, string> = {};
    for (const issue of issues) if (issue.nodeId) map[issue.nodeId] = map[issue.nodeId] ? `${map[issue.nodeId]} · ${issue.message}` : issue.message;
    return map;
  }, [issues]);

  if (status === 'loading' || (workflow && !definition)) return <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>;
  if (status !== 'ready' || !workflow || !definition) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        <p>{t('workflows.notFound')}</p>
        <Link href="/workflows" className="mt-3 inline-block text-primary underline">{t('workflows.backToList')}</Link>
      </div>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 bg-card px-3">
        <Link href="/workflows" className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />{t('workflows.title')}</Link>
        <span className="text-muted-foreground/40">/</span>
        <h1 className="max-w-[28ch] truncate text-[13px] font-semibold">{workflow.name}</h1>
        <Badge variant="outline" className="h-5 text-[10px] font-medium tabular-nums text-muted-foreground">{workflow.published_version ? `v${workflow.published_version}` : t('workflows.draftOnly')}</Badge>
        <button type="button" onClick={() => setDialog('settings')} title={t('workflows.agentHint')} className={cn('inline-flex h-5 max-w-[22ch] items-center gap-1 rounded-md px-1.5 text-[11px] hover:bg-muted', workflow.agent_name ? 'text-muted-foreground' : 'text-destructive')}>
          <Bot className="size-3 shrink-0" /><span className="truncate">{workflow.agent_name ?? t('workflows.noAgent')}</span>
        </button>
        <SaveIndicator state={saveState} error={saveError} />
        <div className="ml-auto flex items-center gap-0.5">
          <label className="mr-2 inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <Switch checked={workflow.enabled === 1} onCheckedChange={(next) => void setEnabled(next)} className="scale-90" />
            {t('workflows.enabled')}
          </label>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={undo} title="Undo (⌘Z)"><Undo2 className="size-4" /></Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={redo} title="Redo (⇧⌘Z)"><Redo2 className="size-4" /></Button>
          <Button variant="ghost" size="sm" className="h-8" onClick={tidy}><WandSparkles className="mr-1 size-3.5" />{t('workflows.tidy')}</Button>
          <Button variant="ghost" size="sm" className="h-8" onClick={() => setDialog('variables')}><Braces className="mr-1 size-3.5" />{t('workflows.variables')}{definition.variables.length > 0 && <span className="ml-1 rounded bg-muted px-1 text-[10px] tabular-nums">{definition.variables.length}</span>}</Button>
          <Button variant="ghost" size="sm" className="h-8" onClick={() => setDialog('settings')}><Settings2 className="mr-1 size-3.5" />{t('workflows.settings')}</Button>
          <Button variant="ghost" size="sm" className="h-8" onClick={() => setRunsOpen(true)}><History className="mr-1 size-3.5" />{t('workflows.runs')}</Button>
          <Button variant="secondary" size="sm" className="ml-2 h-8" disabled={busy !== null || !workflow.agent_name} title={!workflow.agent_name ? t('workflows.runNeedsAgent') : undefined} onClick={() => void run(true)}><Play className="mr-1 size-3.5" />{t('workflows.runDraft')}</Button>
          <Button size="sm" className="h-8" disabled={busy !== null} onClick={() => void publish()}>{busy === 'publish' ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : <Rocket className="mr-1 size-3.5" />}{t('workflows.publish')}</Button>
          <Button variant={rightOpen ? 'secondary' : 'ghost'} size="sm" className="ml-1 h-8 w-8 p-0" onClick={() => setRightOpen((open) => !open)} title={t('workflows.buildWithAi')}><Sparkles className="size-4" /></Button>
        </div>
      </header>
      {issues && issues.length > 0 && (
        <div className="shrink-0 bg-destructive/10 px-3 py-2 text-[11.5px] text-destructive">
          <p className="font-medium">{t('workflows.issuesTitle')} <span className="font-normal text-destructive/80">{t('workflows.issuesHint')}</span></p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
            {issues.map((issue, index) => (
              <li key={index}>
                {issue.nodeId ? <button type="button" className="underline-offset-2 hover:underline" onClick={() => focusNode(issue.nodeId!)}>{issue.message}</button> : <span>{issue.message}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <WorkflowWorkspace open={rightOpen} chat={<ArchitectChat workflow={workflow} current={definition} onAccept={(next) => { update(next); setFitKey((key) => key + 1); }} />}>
        <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card">
          {selectedNode ? (
            <NodeSettings workflow={workflow} definition={definition} node={selectedNode} nodeTypes={nodeTypes} onChange={update} onBack={clearSelection} onFocusNode={focusNode} />
          ) : selection?.kind === 'edge' ? (
            <EdgeSettings definition={definition} edgeId={selection.id} onChange={update} onBack={clearSelection} />
          ) : (
            <>
              <div className="flex items-center gap-2 px-4 py-2.5">
                <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('workflows.add')}</h2>
                <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">{t('workflows.nodeCount', { n: definition.nodes.length })}</span>
              </div>
              <NodePalette nodeTypes={nodeTypes} onAdd={addNode} />
            </>
          )}
        </aside>
        <section className="min-h-0 bg-background">
          <WorkflowCanvas definition={definition} nodeTypes={nodeTypes} selection={selection} issues={issueByNode} fitKey={fitKey} onChange={update} onSelect={onSelect} onAddNode={addNode} />
        </section>
      </WorkflowWorkspace>
      <VariablesDialog open={dialog === 'variables'} definition={definition} onChange={update} onClose={() => setDialog(null)} />
      <SettingsDialog open={dialog === 'settings'} workflow={workflow} definition={definition} onChange={update} onWorkflow={setWorkflow} onClose={() => setDialog(null)} onDelete={() => setDialog('delete')} />
      <Dialog open={dialog === 'delete'} onOpenChange={(next) => { if (!next) setDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('workflows.deleteWorkflow')}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">{t('workflows.deleteConfirm', { name: workflow.name })}</p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialog(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" size="sm" onClick={() => void remove()}><Trash2 className="mr-1 size-3.5" />{t('workflows.deleteWorkflow')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <RunsSheet open={runsOpen} workflow={workflow} slug={slug} onClose={() => setRunsOpen(false)} onRun={() => { setRunsOpen(false); void run(false); }} />
    </main>
  );
}
