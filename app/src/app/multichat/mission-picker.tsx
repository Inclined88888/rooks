'use client';

import { useEffect, useState } from 'react';
import { missionDisplayTitle } from '@/lib/mission-title';
import { Plus } from 'lucide-react';
import type { MissionSummary } from './types';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

function firstLine(s: string | undefined, max: number): string {
  if (!s) return '';
  const line = s.split('\n')[0] || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function fmtRel(ms?: number): string {
  if (!ms) return '';
  if (typeof window === 'undefined') return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function statusBadgeClass(status: string): string {
  if (status === 'running') return 'bg-[hsl(var(--warning))]/20 text-[hsl(var(--warning))]';
  if (status === 'completed') return 'bg-[hsl(var(--success))]/20 text-[hsl(var(--success))]';
  if (status === 'blocked' || status === 'failed') return 'bg-destructive/20 text-destructive';
  if (status === 'paused' || status === 'rateLimited') return 'bg-blue-500/20 text-blue-400';
  return 'bg-muted/40 text-muted-foreground';
}

export function MissionPicker({
  agentName,
  onPick,
  onNewConversation,
}: {
  agentName: string;
  onPick: (missionId: string) => void;
  onNewConversation: () => void;
}) {
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/ui/missions?agent=${encodeURIComponent(agentName)}&limit=12`,
          { cache: 'no-store' },
        );
        if (!r.ok) {
          if (!cancelled) setLoading(false);
          return;
        }
        const j = (await r.json()) as { missions: MissionSummary[] };
        if (cancelled) return;
        setMissions(j.missions ?? []);
        setLoading(false);
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentName]);

  return (
    <div className="flex h-full flex-col overflow-hidden p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">
          {t('multichat.picker.title', { agent: agentName })}
        </h3>
        <button
          type="button"
          onClick={onNewConversation}
          className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20"
        >
          <Plus className="size-3" /> {t('multichat.picker.new')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <p className="text-[11px] text-muted-foreground">{t('multichat.picker.loading')}</p>
        ) : missions.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {t('multichat.picker.empty')}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {missions.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onPick(m.id)}
                className="group rounded-md border border-border/60 bg-card/70 px-2.5 py-1.5 text-left transition-colors hover:border-primary/50 hover:bg-card"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-px text-[8.5px] font-bold uppercase tracking-wider',
                      statusBadgeClass(m.status),
                    )}
                  >
                    {m.status}
                  </span>
                  <span
                    className="tabular-nums text-[9.5px] text-muted-foreground/70"
                    suppressHydrationWarning
                  >
                    {fmtRel(m.started_at)}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-foreground group-hover:text-foreground">
                  {m.title ? missionDisplayTitle(m) : firstLine(m.mission || m.input, 120) || '(no input)'}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
