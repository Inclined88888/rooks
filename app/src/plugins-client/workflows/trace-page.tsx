'use client';

/**
 * `/trace/[traceId]` (PRD §8.4): the causal tree of a trace — missions, tasks,
 * agent messages — and the spans of every mission, in one screen.
 */
import Link from 'next/link';
import { ChatLink } from '@/components/chat/chat-link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bot, ExternalLink, ListChecks, Send } from 'lucide-react';
import { t } from '@/lib/i18n';
import { chatMissionHref } from '@/lib/chat-island-params';
import { cn } from '@/lib/utils';
import { MissionSpansTimeline } from './mission-spans-timeline';
import { RunStatusBadge, TraceTimeline, type TraceGroup } from './trace-panel';
import { formatDuration, formatRelative, formatTokens, type TraceSpan } from './types';

type TraceMission = { id: string; agent_name: string; status: string; started_at: number; ended_at?: number | null; parent_mission_id?: string | null; mission?: string | null; workflow_run_id?: string | null; workflow_node_id?: string | null; task_id?: string | null };
type TraceTask = { id: string; title: string; status: string; type?: string; agent_name?: string | null; created_at?: number };
type TraceMessage = { id: string | number; from_agent?: string; to_agent?: string; body?: string; content?: string; created_at?: number; from_mission?: string | null };
type TraceResponse = { trace_id: string; missions: TraceMission[]; tasks: TraceTask[]; agent_messages: TraceMessage[]; spans: TraceSpan[]; spans_total: number; spans_truncated: boolean; spans_pruned?: number; aggregates: { duration_ms: number; tokens_in: number; tokens_out: number; cost_usd: number; tools: number; errors: number; missions: number } };

// The overview shows the latest spans of the whole trace; a mission's own view pages through all of its spans.
const TRACE_SPAN_LIMIT = 500;

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-[14px] font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

function MissionTree({ missions, selected, onSelect }: { missions: TraceMission[]; selected: string | null; onSelect: (id: string | null) => void }) {
  const children = useMemo(() => {
    const map = new Map<string | null, TraceMission[]>();
    const ids = new Set(missions.map((mission) => mission.id));
    for (const mission of missions) {
      const parent = mission.parent_mission_id && ids.has(mission.parent_mission_id) ? mission.parent_mission_id : null;
      map.set(parent, [...(map.get(parent) ?? []), mission]);
    }
    return map;
  }, [missions]);
  const render = (parent: string | null, depth: number): React.ReactNode => (children.get(parent) ?? []).sort((a, b) => a.started_at - b.started_at).map((mission) => (
    <li key={mission.id}>
      <button type="button" onClick={() => onSelect(selected === mission.id ? null : mission.id)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted', selected === mission.id && 'bg-muted')} style={{ paddingLeft: 8 + depth * 14 }}>
        <Bot className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11.5px] font-medium">{mission.agent_name}</span>
          <span className="block truncate text-[10px] text-muted-foreground">{mission.mission?.slice(0, 80) || mission.id}</span>
        </span>
        <RunStatusBadge status={mission.status === 'done' ? 'completed' : mission.status} />
        <ChatLink href={chatMissionHref(mission.id)} onClick={(event) => event.stopPropagation()} className="text-muted-foreground hover:text-primary"><ExternalLink className="size-3" /></ChatLink>
      </button>
      {children.has(mission.id) && <ul>{render(mission.id, depth + 1)}</ul>}
    </li>
  ));
  return <ul className="space-y-0.5">{render(null, 0)}</ul>;
}

export function TracePage({ traceId }: { traceId: string }) {
  const [data, setData] = useState<TraceResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/ui/trace/${encodeURIComponent(traceId)}?span_limit=${TRACE_SPAN_LIMIT}&payload=0`, { cache: 'no-store' }).then(async (response) => {
      if (cancelled) return;
      if (!response.ok) { setStatus('missing'); return; }
      setData(await response.json() as TraceResponse);
      setStatus('ready');
    }).catch(() => { if (!cancelled) setStatus('missing'); });
    return () => { cancelled = true; };
  }, [traceId]);

  const groups = useMemo<TraceGroup[]>(() => {
    if (!data) return [];
    const missions = selected ? data.missions.filter((mission) => mission.id === selected) : data.missions;
    return missions.map((mission) => ({ key: mission.id, title: `${mission.agent_name} · ${mission.id.slice(0, 8)}`, status: mission.status === 'done' ? 'ok' : mission.status === 'failed' ? 'error' : mission.status, spans: data.spans.filter((span) => span.mission_id === mission.id) })).filter((group) => group.spans.length > 0);
  }, [data, selected]);

  if (status === 'loading') return <div className="p-6 text-sm text-muted-foreground">{t('common.loading')}</div>;
  if (status === 'missing' || !data) return <div className="p-6 text-sm text-muted-foreground"><p>{t('workflows.traceNotFound')}</p><Link href="/missions" className="mt-3 inline-block text-primary underline">{t('workflows.backToMissions')}</Link></div>;

  const workflowRun = data.missions.find((mission) => mission.workflow_run_id)?.workflow_run_id ?? null;
  const a = data.aggregates;
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 bg-card px-3">
        <Link href="/missions" className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />{t('workflows.backToMissions')}</Link>
        <span className="text-muted-foreground/40">/</span>
        <h1 className="text-[13px] font-semibold">{t('workflows.trace')} <span className="tabular-nums text-muted-foreground">{data.trace_id.slice(0, 8)}</span></h1>
        {workflowRun && <Link href={`/workflows/runs/${workflowRun}`} className="ml-2 inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground"><ExternalLink className="size-3" />{t('workflows.openRun')}</Link>}
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[400px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col overflow-auto bg-card p-3">
          <div className="grid grid-cols-3 gap-2">
            <Kpi label={t('workflows.kpi.missions')} value={String(a.missions)} />
            <Kpi label={t('workflows.kpi.tools')} value={String(a.tools)} />
            <Kpi label={t('workflows.kpi.errors')} value={String(a.errors)} tone={a.errors > 0 ? 'text-destructive' : undefined} />
            <Kpi label={t('workflows.kpi.duration')} value={formatDuration(a.duration_ms)} />
            <Kpi label={t('workflows.kpi.tokens')} value={formatTokens(a.tokens_in + a.tokens_out)} />
            <Kpi label={t('workflows.kpi.cost')} value={`$${a.cost_usd.toFixed(3)}`} />
          </div>
          <h2 className="mb-1 mt-4 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"><Bot className="size-3" />{t('workflows.kpi.missions')}</h2>
          <MissionTree missions={data.missions} selected={selected} onSelect={setSelected} />
          {data.tasks.length > 0 && (
            <>
              <h2 className="mb-1 mt-4 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"><ListChecks className="size-3" />{t('workflows.tasks')}</h2>
              <ul className="space-y-0.5">
                {data.tasks.map((task) => (
                  <li key={task.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px]">
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                    {task.type && <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{task.type}</span>}
                    <span className="text-[10px] text-muted-foreground">{task.status}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {data.agent_messages.length > 0 && (
            <>
              <h2 className="mb-1 mt-4 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"><Send className="size-3" />{t('workflows.messages')}</h2>
              <ul className="space-y-0.5">
                {data.agent_messages.map((message) => (
                  <li key={String(message.id)} className="rounded-md px-2 py-1.5 text-[11px]">
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><span>{message.from_agent}</span>→<span>{message.to_agent}</span><span className="ml-auto">{formatRelative(message.created_at)}</span></div>
                    <p className="mt-0.5 line-clamp-2 text-muted-foreground">{message.body ?? message.content ?? ''}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
        <section className="flex min-h-0 flex-col">
          <div className="flex items-center gap-2 px-4 py-2.5">
            <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t('workflows.trace')}</h2>
            <span className="ml-auto text-[11px] text-muted-foreground">{selected ? data.missions.find((mission) => mission.id === selected)?.agent_name : t('workflows.allMissions')}</span>
            {selected && <button type="button" onClick={() => setSelected(null)} className="text-[10.5px] text-primary hover:underline">{t('workflows.allMissions')}</button>}
          </div>
          {selected
            ? <MissionSpansTimeline key={selected} missionId={selected} live={false} filterable />
            : <TraceTimeline groups={groups} notice={data.spans_truncated ? t('workflows.spansTruncated', { shown: data.spans.length, total: data.spans_total }) : data.spans_pruned ? t('workflows.tracePruned', { count: data.spans_pruned }) : undefined} />}
        </section>
      </div>
    </main>
  );
}
