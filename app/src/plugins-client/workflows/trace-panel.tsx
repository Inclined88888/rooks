'use client';

/**
 * Trace timeline (PRD §8.3, capture 1 left column): the chronological list of
 * what an agent did — memory read, tools called, thinking, permissions — with
 * status, duration and tokens per span. Shared by the run view, `/trace` and
 * the mission drawer, so the three screens read the same way.
 */
import { ChatLink } from '@/components/chat/chat-link';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Box,
  Brain,
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  GitFork,
  MessageSquare,
  OctagonX,
  Send,
  ShieldQuestion,
  Wrench,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import { t } from '@/lib/i18n';
import { chatMissionHref } from '@/lib/chat-island-params';
import { cn } from '@/lib/utils';
import { formatDuration, formatTokens, prettyJson, safeJson, type TraceSpan } from './types';

export function RunStatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = (() => {
    switch (status) {
      case 'completed': case 'ok': return { label: t(`workflows.runStatus.${status}`), cls: 'bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]', dot: 'bg-[hsl(var(--success))]' };
      case 'running': return { label: t('workflows.runStatus.running'), cls: 'bg-primary/15 text-primary', dot: 'bg-primary animate-pulse' };
      case 'waiting': case 'pending': return { label: t(`workflows.runStatus.${status}`), cls: 'bg-[hsl(var(--warning)/0.18)] text-[hsl(var(--warning))]', dot: 'bg-[hsl(var(--warning))]' };
      case 'failed': case 'error': case 'timeout': return { label: t(`workflows.runStatus.${status}`), cls: 'bg-destructive/15 text-destructive', dot: 'bg-destructive' };
      default: return { label: t(`workflows.runStatus.${status}`), cls: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' };
    }
  })();
  const label = tone.label.startsWith('workflows.') ? status : tone.label;
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider', tone.cls, className)}>
      <span className={cn('size-1.5 rounded-full', tone.dot)} />{label}
    </span>
  );
}

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  turn: MessageSquare, tool: Wrench, thinking: Brain, permission: ShieldQuestion, spawn: GitFork, message: Send, switch: ArrowLeftRight, interrupt: OctagonX, node: Box, workflow: WorkflowIcon,
};

export function SpanIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = KIND_ICON[kind] ?? Box;
  return <Icon className={className} />;
}

function StatusMark({ status }: { status: string }) {
  if (status === 'ok') return <Check className="size-3.5 text-[hsl(var(--success))]" />;
  if (status === 'running') return <span className="size-2 animate-pulse rounded-full bg-primary" />;
  if (['error', 'denied', 'timeout', 'interrupted'].includes(status)) return <CircleAlert className="size-3.5 text-destructive" />;
  return <Clock3 className="size-3.5 text-muted-foreground" />;
}

function spanTitle(span: TraceSpan): string {
  if (span.kind === 'tool' && span.name.startsWith('mcp__')) {
    const parts = span.name.split('__');
    return parts.length >= 3 ? `${parts[1]} · ${parts.slice(2).join('__')}` : span.name;
  }
  if (span.kind === 'turn') return t('workflows.span.turn');
  if (span.kind === 'thinking') return t('workflows.span.thinking');
  return span.name;
}

function spanMeta(span: TraceSpan): string {
  const bits: string[] = [];
  if (span.duration_ms !== null && span.duration_ms !== undefined) bits.push(formatDuration(span.duration_ms));
  else if (span.status === 'running') bits.push(formatDuration(Date.now() - span.started_at));
  const tokens = (span.tokens_in ?? 0) + (span.tokens_out ?? 0);
  if (tokens > 0) bits.push(`${formatTokens(tokens)} tok`);
  if (span.cost_usd) bits.push(`$${span.cost_usd.toFixed(3)}`);
  return bits.join(' · ');
}

/** A timeline row carries no payload (the list routes leave the wide columns
 *  out); the span that gets opened fetches its own, from `payload_url` when
 *  the row names one. */
function useSpanPayload(span: TraceSpan): TraceSpan {
  const [loaded, setLoaded] = useState<TraceSpan | null>(null);
  const missing = span.input === undefined;
  useEffect(() => {
    setLoaded(null);
    if (!missing) return undefined;
    let cancelled = false;
    const url = span.payload_url ?? `/api/ui/missions/${encodeURIComponent(span.mission_id)}/spans/${encodeURIComponent(span.id)}`;
    void fetch(url, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled || !response.ok) return;
        const value = await response.json() as { span?: TraceSpan };
        if (value.span && !cancelled) setLoaded({ ...span, ...value.span, cursor: span.cursor });
      })
      .catch(() => { /* the row stays openable, just without its payload */ });
    return () => { cancelled = true; };
  }, [span.id, span.mission_id, span.payload_url, missing]); // eslint-disable-line react-hooks/exhaustive-deps
  return loaded ?? span;
}

export function SpanDetail({ span: row, onClose }: { span: TraceSpan; onClose: () => void }) {
  const span = useSpanPayload(row);
  const input = safeJson(span.input);
  const output = safeJson(span.output);
  return (
    <div className="mx-2 mb-2 flex max-h-[45%] min-h-0 flex-col rounded-xl bg-muted/40">
      <div className="flex items-center gap-2 px-3 py-2">
        <SpanIcon kind={span.kind} className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{spanTitle(span)}</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">{spanMeta(span)}</span>
        <ChatLink href={chatMissionHref(span.mission_id)} className="inline-flex items-center gap-1 text-[10.5px] text-primary hover:underline"><ExternalLink className="size-3" />{t('workflows.openChat')}</ChatLink>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-3 pb-3">
        {/* code-font: the raw error of the span */}
        {span.error && <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-2 font-mono text-[10.5px] text-destructive">{span.error}</pre>}
        {input !== null && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('workflows.input')}</div>
            {/* code-font: the span input as JSON */}
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-[hsl(var(--surface-sunken))] p-2 font-mono text-[10.5px]">{prettyJson(input)}</pre>
          </div>
        )}
        {output !== null && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('workflows.output')}</div>
            {/* code-font: the span output as JSON */}
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-[hsl(var(--surface-sunken))] p-2 font-mono text-[10.5px]">{prettyJson(output)}</pre>
          </div>
        )}
        {input === null && output === null && !span.error && span.input !== undefined && <p className="text-[10.5px] text-muted-foreground">{t('workflows.noPayload')}</p>}
      </div>
    </div>
  );
}

export type TraceGroup = { key: string; title: string; status?: string; spans: TraceSpan[] };

const SpanRowButton = memo(function SpanRowButton({ span, active, onToggle }: { span: TraceSpan; active: boolean; onToggle: (span: TraceSpan) => void }) {
  const error = ['error', 'denied', 'timeout', 'interrupted'].includes(span.status);
  return (
    <li className="relative">
      <span className="absolute -left-[17px] top-2 flex size-3 items-center justify-center rounded-full bg-background"><StatusMark status={span.status} /></span>
      <button
        type="button"
        onClick={() => onToggle(span)}
        className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted', active && 'bg-muted', span.kind === 'thinking' && 'text-muted-foreground')}
      >
        <SpanIcon kind={span.kind} className={cn('size-3.5 shrink-0', error ? 'text-destructive' : 'text-muted-foreground')} />
        <span className={cn('min-w-0 flex-1 truncate text-[11.5px]', error ? 'text-destructive' : '')}>{spanTitle(span)}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{spanMeta(span)}</span>
      </button>
    </li>
  );
});

/** A paged source: only the latest window is in memory, older ones come on request. */
export type TracePaging = { hasOlder: boolean; loading: boolean; remaining: number; onLoadOlder: () => void };

export function TraceTimeline({ groups, emptyLabel, filterable = true, paging, notice, followTail = false }: {
  groups: TraceGroup[];
  emptyLabel?: string;
  filterable?: boolean;
  paging?: TracePaging;
  /** A line above the list, e.g. "showing the latest N of M". */
  notice?: string;
  /** Keep the newest span in view while the reader sits at the bottom (live cards). */
  followTail?: boolean;
}) {
  const [kind, setKind] = useState<string>('');
  const [active, setActive] = useState<TraceSpan | null>(null);
  const kinds = useMemo(() => [...new Set(groups.flatMap((group) => group.spans.map((span) => span.kind)))].filter((item) => item !== 'workflow'), [groups]);
  const visible = useMemo(() => groups.map((group) => ({ ...group, spans: group.spans.filter((span) => span.kind !== 'workflow' && (!kind || span.kind === kind)) })).filter((group) => group.spans.length > 0), [groups, kind]);
  const total = groups.reduce((n, group) => n + group.spans.length, 0);
  const toggle = useCallback((span: TraceSpan) => setActive((current) => (current?.id === span.id ? null : span)), []);

  // Scroll behaviour of a window that grows at both ends: stay on the newest
  // span when the reader was at the bottom, and keep the reader's place when an
  // older page lands above.
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const anchor = useRef<number | null>(null);
  const loadOlder = useCallback(() => {
    if (scroller.current) anchor.current = scroller.current.scrollHeight - scroller.current.scrollTop;
    paging?.onLoadOlder();
  }, [paging]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (anchor.current !== null) { el.scrollTop = el.scrollHeight - anchor.current; anchor.current = null; return; }
    if (followTail && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [total, followTail]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {filterable && kinds.length > 1 && (
        <div className="flex flex-wrap gap-1 px-3 py-2">
          <button type="button" onClick={() => setKind('')} className={cn('rounded-md border px-1.5 py-px text-[10px]', !kind ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted')}>{t('workflows.allKinds')}</button>
          {kinds.map((item) => (
            <button key={item} type="button" onClick={() => setKind(item)} className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10px]', kind === item ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted')}>
              <SpanIcon kind={item} className="size-2.5" />{t(`workflows.span.${item}`).replace(/^workflows\.span\./, '')}
            </button>
          ))}
        </div>
      )}
      <div
        ref={scroller}
        onScroll={(event) => { const el = event.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}
        className="min-h-0 flex-1 overflow-auto px-2 py-2"
      >
        {notice && <p className="mb-2 rounded-md bg-muted px-2 py-1 text-[10.5px] text-muted-foreground" data-testid="trace-notice">{notice}</p>}
        {paging?.hasOlder && (
          <button type="button" disabled={paging.loading} onClick={loadOlder} data-testid="trace-load-older" className="mb-2 w-full rounded-md border border-dashed border-border px-2 py-1 text-[10.5px] text-muted-foreground hover:bg-muted disabled:opacity-60">
            {paging.loading ? t('common.loading') : t('workflows.loadOlder', { count: paging.remaining })}
          </button>
        )}
        {total === 0 && <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-foreground">{emptyLabel ?? t('workflows.noSpans')}</p>}
        {visible.map((group) => (
          <section key={group.key} className="mb-3">
            {groups.length > 1 && (
              <div className="flex items-center gap-2 px-1.5 pb-1">
                {group.status && <StatusMark status={group.status === 'error' || group.status === 'timeout' ? 'error' : group.status === 'ok' ? 'ok' : group.status} />}
                <span className="truncate text-[11px] font-semibold">{group.title}</span>
                <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">{group.spans.length}</span>
              </div>
            )}
            <ol className="relative ml-2.5 pl-3">
              {group.spans.map((span) => <SpanRowButton key={span.id} span={span} active={active?.id === span.id} onToggle={toggle} />)}
            </ol>
          </section>
        ))}
      </div>
      {active && <SpanDetail span={active} onClose={() => setActive(null)} />}
    </div>
  );
}
