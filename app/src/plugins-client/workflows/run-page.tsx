'use client';

/**
 * Run view (`/workflows/[slug]/runs/[runId]`, PRD §8.3): the frozen version
 * the run executed, read-only, each node with its status, duration and
 * tokens; the trace of the selected node (or the whole run) on the left.
 * Live through the `workflow_run` bus event, with a slow poll as a net.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Ban, ExternalLink, Layers, LoaderCircle, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SegControl } from '@/components/seg-control';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { sseOn } from '@/lib/sse-stream';
import { cn } from '@/lib/utils';
import { AgentFacets } from './agent-facets';
import { nodeTypeLabel } from './node-catalog';
import { RunStatusBadge, TraceTimeline, type TraceGroup } from './trace-panel';
import { WorkflowCanvas, type CanvasSelection } from './workflow-canvas';
import { formatDuration, formatRelative, formatTokens, parseDefinition, runDuration, safeJson, sameJson, type NodeType, type RunNode, type TraceSpan, type Workflow, type WorkflowDefinition, type WorkflowRun } from './types';

const ACTIVE = new Set(['pending', 'running', 'waiting']);

/** `spans` is a window: the run's structure and its most recent spans, without payloads. */
type RunDetail = { run: WorkflowRun; workflow: Pick<Workflow, 'id' | 'slug' | 'name' | 'published_version'> | null; definition: WorkflowDefinition | null; nodes: RunNode[]; spans: TraceSpan[]; spans_total?: number; spans_truncated?: boolean };

function useRun(runId: string) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/ui/workflows/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
      if (!response.ok) { setStatus('missing'); return; }
      const value = await response.json() as RunDetail;
      const base = `/api/ui/workflows/runs/${encodeURIComponent(runId)}/spans/`;
      value.spans = value.spans.map((span) => ({ ...span, payload_url: `${base}${encodeURIComponent(span.id)}` }));
      setDetail((previous) => (previous && sameJson(previous, value) ? previous : value));
      setStatus('ready');
    } catch { setStatus('missing'); }
  }, [runId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => sseOn('workflow_run', (event) => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const payload = JSON.parse(event.data) as { runId?: string };
      if (payload.runId === runId) void load();
    } catch { /* ignore a malformed frame */ }
  }), [load, runId]);
  const active = detail ? ACTIVE.has(detail.run.status) : true;
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [active, load]);
  return { detail, status, reload: load };
}

function HumanCard({ runId, node, question, options, onAnswered }: { runId: string; node: RunNode; question: string; options: string[]; onAnswered: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const answer = async (value: string) => {
    setBusy(value);
    try {
      const response = await fetch(`/api/ui/human/${runId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ node_id: node.node_id, answer: value }) });
      if (!response.ok) toast.error(t('workflows.human.stale'));
      onAnswered();
    } finally { setBusy(null); }
  };
  const choices = options.length > 0 ? options : ['approved', 'rejected'];
  return (
    <div className="m-2 rounded-xl border border-[hsl(var(--warning)/0.5)] bg-[hsl(var(--warning)/0.08)] p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[hsl(var(--warning))]"><UserCheck className="size-3.5" />{t('workflows.human.title')}</div>
      <p className="mt-1.5 text-[12px] leading-snug">{question}</p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {choices.map((choice) => (
          <Button key={choice} size="sm" variant={choice === 'rejected' ? 'outline' : 'default'} className="h-7 text-[11px]" disabled={busy !== null} onClick={() => void answer(choice)}>
            {busy === choice && <LoaderCircle className="mr-1 size-3 animate-spin" />}{choice}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function WorkflowRunPage({ slug, runId }: { slug: string; runId: string }) {
  const { detail, status, reload } = useRun(runId);
  const [nodeTypes, setNodeTypes] = useState<NodeType[]>([]);
  const [selection, setSelection] = useState<CanvasSelection>(null);
  const [mode, setMode] = useState<'graph' | 'agent'>('graph');
  const [agentNodeId, setAgentNodeId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    void fetch('/api/ui/workflows/node-types', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : { nodeTypes: [] })).then((value: { nodeTypes?: NodeType[] }) => setNodeTypes(value.nodeTypes ?? [])).catch(() => undefined);
  }, []);
  const active = detail ? ACTIVE.has(detail.run.status) : false;
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const definition = useMemo(() => (detail?.definition ? parseDefinition(detail.definition) : null), [detail?.definition]);
  const onSelect = useCallback((next: CanvasSelection) => setSelection((current) => (sameJson(current, next) ? current : next)), []);
  const agentNodes = useMemo(() => definition?.nodes.filter((node) => node.type === 'agent' || node.type === 'skill') ?? [], [definition]);
  const focusedAgent = agentNodeId ?? (selection?.kind === 'node' && agentNodes.some((node) => node.id === selection.id) ? selection.id : agentNodes[0]?.id ?? null);

  const groups = useMemo<TraceGroup[]>(() => {
    if (!detail || !definition) return [];
    const latest = new Map<string, RunNode>();
    for (const row of detail.nodes) { const current = latest.get(row.node_id); if (!current || current.attempt < row.attempt) latest.set(row.node_id, row); }
    const byNode = new Map<string, TraceSpan[]>();
    const orphan: TraceSpan[] = [];
    for (const span of detail.spans) {
      if (span.kind === 'workflow') continue;
      if (span.workflow_node_id) byNode.set(span.workflow_node_id, [...(byNode.get(span.workflow_node_id) ?? []), span]);
      else orphan.push(span);
    }
    const forNode = (id: string) => {
      const spans = byNode.get(id) ?? [];
      const rich = spans.filter((span) => span.kind !== 'node');
      return rich.length > 0 ? rich : spans;
    };
    if (selection?.kind === 'node') {
      const node = definition.nodes.find((item) => item.id === selection.id);
      return [{ key: selection.id, title: node?.label || selection.id, status: latest.get(selection.id)?.status, spans: forNode(selection.id) }];
    }
    const result: TraceGroup[] = definition.nodes
      .map((node) => ({ key: node.id, title: `${node.label || node.id} · ${nodeTypeLabel(node.type)}`, status: latest.get(node.id)?.status, spans: forNode(node.id) }))
      .filter((group) => group.spans.length > 0);
    if (orphan.length) result.push({ key: '__run', title: t('workflows.wholeRun'), spans: orphan });
    return result;
  }, [definition, detail, selection]);

  const waitingHuman = useMemo(() => {
    if (!detail || !definition) return null;
    const row = detail.nodes.find((item) => item.status === 'waiting' && definition.nodes.find((node) => node.id === item.node_id)?.type === 'human');
    if (!row) return null;
    const payload = safeJson(row.output) as { question?: string; options?: string[] } | null;
    const node = definition.nodes.find((item) => item.id === row.node_id);
    return { row, question: payload?.question ?? String(node?.config.question ?? ''), options: Array.isArray(payload?.options) ? payload.options : [] };
  }, [definition, detail]);

  const cancel = useCallback(async () => {
    const response = await fetch(`/api/ui/workflows/runs/${runId}/cancel`, { method: 'POST' });
    if (!response.ok) toast.error(t('workflows.cancelError'));
    setConfirmCancel(false);
    void reload();
  }, [reload, runId]);

  if (status === 'loading') return <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>;
  if (status === 'missing' || !detail || !definition) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        <p>{t('workflows.runNotFound')}</p>
        <Link href={`/workflows/${encodeURIComponent(slug)}`} className="mt-3 inline-block text-primary underline">{t('workflows.backToBuilder')}</Link>
      </div>
    );
  }

  const { run, workflow } = detail;
  const slugValue = slug || workflow?.slug || '';
  const trigger = safeJson(run.trigger) as { kind?: string } | null;
  const tokens = (run.tokens_in ?? 0) + (run.tokens_out ?? 0);
  const selectedLabel = selection?.kind === 'node' ? definition.nodes.find((node) => node.id === selection.id)?.label ?? selection.id : null;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 bg-card px-3">
        <Link href={`/workflows/${encodeURIComponent(slugValue)}`} className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />{workflow?.name ?? slug}</Link>
        <span className="text-muted-foreground/40">/</span>
        <h1 className="text-[13px] font-semibold">{t('workflows.run')} <span className="tabular-nums text-muted-foreground">{run.id.slice(0, 8)}</span></h1>
        <RunStatusBadge status={run.status} className="ml-1" />
        <Badge variant="outline" className="h-5 text-[10px] font-medium tabular-nums text-muted-foreground">v{run.version}{definition.draft ? ` · ${t('workflows.draft')}` : ''}</Badge>
        {trigger?.kind && <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">{trigger.kind}</span>}
        <div className="ml-auto flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
          <span title={formatDateTime(run.started_at)}>{formatRelative(run.started_at)}</span>
          <span>{formatDuration(runDuration(run))}</span>
          <span>{formatTokens(tokens)} tok</span>
          {run.cost_usd ? <span>${run.cost_usd.toFixed(3)}</span> : null}
          {run.error && <span className="max-w-[24ch] truncate text-destructive" title={run.error}>{run.error}</span>}
        </div>
        {active && (
          confirmCancel ? (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="destructive" className="h-7" onClick={() => void cancel()}>{t('workflows.cancelConfirm')}</Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => setConfirmCancel(false)}>{t('common.cancel')}</Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="h-7" onClick={() => setConfirmCancel(true)}><Ban className="mr-1 size-3.5" />{t('workflows.cancelRun')}</Button>
          )
        )}
        <Link href={`/workflows/${encodeURIComponent(slugValue)}`} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"><ExternalLink className="size-3.5" />{t('workflows.openInBuilder')}</Link>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col bg-card">
          <div className="flex items-center gap-2 px-4 py-2.5">
            <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('workflows.trace')}</h2>
            <span className="ml-auto truncate text-[11px] text-muted-foreground">{selectedLabel ?? t('workflows.wholeRun')}</span>
            {selection && <button type="button" onClick={() => setSelection(null)} className="text-[10.5px] text-primary hover:underline">{t('workflows.wholeRun')}</button>}
          </div>
          {waitingHuman && <HumanCard runId={run.id} node={waitingHuman.row} question={waitingHuman.question} options={waitingHuman.options} onAnswered={() => void reload()} />}
          <TraceTimeline groups={groups} emptyLabel={active ? t('workflows.traceWaiting') : t('workflows.noSpans')}
            notice={detail.spans_truncated ? t('workflows.runSpansTruncated', { shown: detail.spans.length, total: detail.spans_total ?? detail.spans.length }) : undefined} />
        </aside>
        <section className="relative min-h-0 bg-background">
          {mode === 'graph' ? (
            <WorkflowCanvas definition={definition} nodeTypes={nodeTypes} runNodes={detail.nodes} readOnly selection={selection} onSelect={onSelect}>
              <SegControl value={mode} items={[{ value: 'graph', label: t('workflows.mode.graph') }, { value: 'agent', label: t('workflows.mode.agent') }]} onChange={setMode} className="bg-card" />
            </WorkflowCanvas>
          ) : (
            <>
              <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
                {agentNodes.length > 1 && (
                  <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5">
                    {agentNodes.map((node) => (
                      <button key={node.id} type="button" onClick={() => setAgentNodeId(node.id)} className={cn('rounded px-2 py-1 text-[11px]', focusedAgent === node.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')}>{node.label || node.id}</button>
                    ))}
                  </div>
                )}
                <SegControl value={mode} items={[{ value: 'graph', label: t('workflows.mode.graph') }, { value: 'agent', label: t('workflows.mode.agent') }]} onChange={setMode} className="bg-card" />
              </div>
              {focusedAgent ? (
                <AgentFacets definition={definition} nodeId={focusedAgent} runNodes={detail.nodes} spans={detail.spans} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"><Layers className="size-6" />{t('workflows.noAgentNode')}</div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
