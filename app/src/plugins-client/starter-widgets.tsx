'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChatLink } from '@/components/chat/chat-link';
import { t } from '@/lib/i18n';
import { chatHref } from '@/lib/chat-island-params';

type Row = { id?: string; slug?: string; name?: string; title?: string; agent?: string; agent_name?: string; created_at?: number; started_at?: number; mission?: string; task_title?: string };

function Overview({ kind }: { kind: 'projects' | 'missions' }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/ui/${kind}`, { cache: 'no-store', signal: abort.signal });
        if (!response.ok) throw new Error();
        const body = await response.json();
        const items = Array.isArray(body[kind]) ? body[kind] as Row[] : [];
        setRows(kind === 'missions' ? [...items].sort((a, b) => (b.started_at ?? b.created_at ?? 0) - (a.started_at ?? a.created_at ?? 0)).slice(0, 12) : items);
        setState('ready');
      } catch { if (!abort.signal.aborted) setState('error'); }
    }
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [kind]);
  return <div className="h-full overflow-y-auto p-3 text-sm">
    {state !== 'ready' ? <p role="status" className="text-muted-foreground">{t(state === 'loading' ? 'starterWidgets.loading' : 'starterWidgets.failed')}</p>
      : rows.length === 0 ? <Link href={`/${kind}`} className="text-muted-foreground underline">{t(`starterWidgets.${kind}Empty`)}</Link>
      : <ul className="space-y-0.5">{rows.map((row, index) => {
        const agent = row.agent_name ?? row.agent;
        const href = kind === 'projects' ? `/agents?project=${encodeURIComponent(row.slug ?? '')}`
          : agent ? chatHref(agent, row.id) : '/missions';
        return <li key={row.id ?? row.slug ?? row.name ?? index}><ChatLink className="block truncate rounded px-1.5 py-2.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" href={href}>{row.title || row.task_title || row.mission?.split("\n")[0] || row.name || row.slug || row.id}</ChatLink></li>;
      })}</ul>}
  </div>;
}
export function ProjectsOverview() { return <Overview kind="projects" />; }
export function RecentMissions() { return <Overview kind="missions" />; }
