'use client';

import { sseOn } from '@/lib/sse-stream';
import { useEffect, useRef, useState } from 'react';
import { TopBar } from '@/components/topbar';
import { ModulePageGate } from '@/lib/plugin-host/module-page-gate';
import { PageIslandHost } from '@/components/islands/page-island-host';
import { createMissionAgentResolver, eventAgentLabel, fetchMissionAgent } from '@/lib/event-agent-label';

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function deriveMsg(p: unknown): string {
  const payload = p as Record<string, unknown> | null;
  let msg = payload?.subtype ? `${payload.type}:${payload.subtype}` : (payload?.type as string) || '';
  if (payload?.type === 'assistant' && payload.message && Array.isArray((payload.message as any).content)) {
    const content = (payload.message as any).content as Array<{ type: string; text?: string; name?: string }>;
    const txts = content.filter((b) => b.type === 'text').map((b) => b.text || '').join(' ').slice(0, 100);
    const tools = content.filter((b) => b.type === 'tool_use').map((b) => 'tool:' + b.name).join(' ');
    msg = txts || tools || 'assistant';
  } else if (payload?.type === 'result') {
    msg = 'result · $' + ((payload.total_cost_usd as number) || 0).toFixed(4);
  }
  return msg;
}

function typeClass(t: string): string {
  if (t === 'PreToolUse') return 't-pre';
  if (t === 'PostToolUse') return 't-post';
  if (t === 'Stop') return 't-stop';
  if (t === 'SubagentStop') return 't-sub';
  if (t === 'SubagentStart') return 't-spawn';
  if (t === 'UserPromptSubmit') return 't-user';
  if (t === 'Notification') return 't-notify';
  if (t === 'Error') return 't-error';
  return '';
}

const FILTERS = ['all', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'UserPromptSubmit', 'Notification'];

function EventsPageBody() {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('all');
  const filterRef = useRef('all');

  useEffect(() => { filterRef.current = filter; }, [filter]);

  const [resolver] = useState(() => createMissionAgentResolver(fetchMissionAgent));

  /** `ag` is a label, or a mission whose agent is filled in once known: the
   *  row is placed now so the stream keeps its order. */
  function pushEvent(ag: string | { missionId: string }, type: string, msg: string) {
    if (filterRef.current !== 'all' && filterRef.current !== type) return;
    const body = bodyRef.current;
    if (!body) return;
    const el = document.createElement('div');
    el.className = `ev ${typeClass(type)} fresh`;
    el.innerHTML = `
      <span class="ts">${new Date().toTimeString().slice(0, 8)}</span>
      <span class="ag">${escapeHtml(typeof ag === 'string' ? ag : eventAgentLabel(null, ag.missionId))}</span>
      <span class="ty">${escapeHtml(type)}</span>
      <span class="ms">${escapeHtml(msg)}</span>`;
    body.appendChild(el);
    while (body.childElementCount > 500) body.removeChild(body.firstChild!);
    body.scrollTop = body.scrollHeight;
    if (typeof ag !== 'string') {
      const cell = el.querySelector<HTMLElement>('.ag');
      void resolver.label(ag.missionId).then((label) => { if (cell) cell.textContent = label; });
    }
  }

  useEffect(() => {
    // Seed with recent events
    (async () => {
      try {
        const r = await fetch('/api/ui/events/recent?limit=300', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as { events: Array<{ mission_id: string; agent_name: string | null; type: string; payload: unknown }> };
        for (const ev of j.events ?? []) {
          resolver.remember(ev.mission_id, ev.agent_name);
          pushEvent(eventAgentLabel(ev.agent_name, ev.mission_id), ev.type || 'event', deriveMsg(ev.payload));
        }
      } catch { /* silent */ }
    })();

    const stopEvents = sseOn('event', (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data);
        const p = ev.payload || {};
        pushEvent({ missionId: String(ev.missionId) }, ev.type || p.type || 'event', deriveMsg(p));
      } catch {}
    });
    const stopMissions = sseOn('mission_complete', (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data);
        pushEvent({ missionId: String(ev.missionId) }, 'mission_complete', ev.missionId.slice(0, 8) + ' · ' + ev.status);
      } catch {}
    });

    return () => { stopEvents(); stopMissions(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <div className="fixed inset-x-0 top-0 z-[6]">
        <TopBar />
      </div>
      {/* The TopBar stays out of the workspace; the stream is the route's island. */}
      <PageIslandHost>
        <div className="flex flex-1 flex-col pl-[var(--rooks-nav-w)] pt-[var(--rooks-topbar-h)] h-full">
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            <span className="flex items-center gap-2 font-semibold text-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-[hsl(var(--success))] shadow-[0_0_8px_hsl(var(--success))]" />
              EVENT STREAM
            </span>
            <span /* code-font: shell command name */ className="font-mono text-muted-foreground">tail –f</span>
            <div className="ml-auto flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => {
                    setFilter(f);
                    if (bodyRef.current) bodyRef.current.innerHTML = '';
                  }}
                  className={
                    'rounded border px-2 py-0.5 text-[10.5px] normal-case ' +
                    (filter === f
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground')
                  }
                >
                  {f}
                </button>
              ))}
              <button
                onClick={() => { if (bodyRef.current) bodyRef.current.innerHTML = ''; }}
                className="rounded border border-border px-2 py-0.5 text-[10.5px] normal-case text-muted-foreground hover:text-foreground"
              >
                clear
              </button>
            </div>
          </div>
          <div
            ref={bodyRef}
            /* code-font: raw event log stream */ className="flex-1 overflow-auto bg-background px-4 pb-4 pt-2 font-mono text-[11.5px] leading-relaxed"
          />
        </div>
      </PageIslandHost>

      <style>{`
        .ev { display: grid; grid-template-columns: 58px 1fr 160px 1fr; gap: 8px;
              color: hsl(var(--foreground) / 0.72); padding: 1.5px 0; align-items: baseline; }
        .ev .ts { color: hsl(var(--muted-foreground) / 0.7); }
        .ev .ag { color: hsl(var(--foreground) / 0.85); font-size: 10.5px; }
        .ev .ty { font-weight: 500; }
        .ev .ms { color: hsl(var(--foreground) / 0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ev.t-pre .ty   { color: hsl(var(--info)); }
        .ev.t-post .ty  { color: hsl(var(--success)); }
        .ev.t-stop .ty, .ev.t-sub .ty, .ev.t-spawn .ty { color: hsl(var(--primary)); }
        .ev.t-user .ty  { color: #c89aff; }
        .ev.t-notify .ty{ color: hsl(var(--warning)); }
        .ev.t-error .ty { color: hsl(var(--destructive)); }
        .ev.fresh { animation: ev-fade-in .2s ease; }
        @keyframes ev-fade-in { from { opacity: 0; transform: translateX(-4px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}

export default function EventsPage() {
  return (
    <ModulePageGate>
      <EventsPageBody />
    </ModulePageGate>
  );
}
