'use client';

/**
 * A mission's network activity (TODO #590, T4): the hosts it contacted, the
 * new ones first, and its recent connections, page by page.
 *
 * Two placements of one view, both slot occupants of `@rooks/missions`:
 * a card of the chat rails (`EgressWidget`, the conversation on screen) and a
 * content of the island workspace (`EgressIsland`, a mission named by its
 * params), which is what the new-host alert opens (`lib/egress-deep-link.ts`).
 *
 * Refreshed by invalidation: the end of one of the mission's turns (a tunnel
 * is journaled when it closes, often at the end of a turn), plus a slow poll
 * while the page is visible. Never a tight loop.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ArrowDown, ArrowUp, Columns2, RefreshCw } from 'lucide-react';
import { useChatRail } from '@/components/chat/chat-rails';
import { fmtRelativeShort, fmtSize } from '@/components/chat/chat-format';
import { useIslandContent } from '@/components/islands/island-content';
import { openInIsland, useIslandBus } from '@/lib/island-bus';
import { useAfterConversation } from '@/lib/load-priority';
import { sseOn } from '@/lib/sse-stream';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { cn } from '@/lib/utils';
import {
  connectionFailed,
  egressIslandContent,
  fetchMissionEgress,
  formatDuration,
  newHostSet,
  orderHosts,
  type EgressConnection,
  type EgressFailure,
  type MissionEgress,
} from '@/lib/egress';

/** Slow on purpose: the turn's end already refreshes, this only catches a long turn. */
export const EGRESS_POLL_MS = 20_000;

type Loaded = {
  head: MissionEgress;
  /** Every connection read so far, newest first, deduplicated by id. */
  rows: EgressConnection[];
  hasMore: boolean;
  /** An older page was read: `hasMore` is that page's, not the head's. */
  olderRead: boolean;
};

function mergeRows(known: readonly EgressConnection[], incoming: readonly EgressConnection[]): EgressConnection[] {
  const byId = new Map<number, EgressConnection>();
  for (const row of known) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export function EgressView({ missionId, onOpenInSplit }: { missionId: string; onOpenInSplit?: () => void }): ReactElement {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<EgressFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const alive = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const read = await fetchMissionEgress(missionId);
      if (!alive.current) return;
      if (!read.ok) {
        setFailure(read.failure);
        return;
      }
      setFailure(null);
      setLoaded((prev) => ({
        head: read.data,
        rows: mergeRows(prev?.rows ?? [], read.data.connections),
        hasMore: prev?.olderRead ? prev.hasMore : read.data.has_more,
        olderRead: prev?.olderRead ?? false,
      }));
    } finally {
      inFlight.current = false;
      if (alive.current) setRefreshing(false);
    }
  }, [missionId]);

  const loadOlder = useCallback(async () => {
    if (!loaded || loadingOlder) return;
    const oldest = loaded.rows[loaded.rows.length - 1];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const read = await fetchMissionEgress(missionId, oldest.id);
      if (!alive.current) return;
      if (!read.ok) {
        setFailure(read.failure);
        return;
      }
      setLoaded((prev) => prev && ({
        ...prev,
        rows: mergeRows(prev.rows, read.data.connections),
        hasMore: read.data.has_more,
        olderRead: true,
      }));
    } finally {
      if (alive.current) setLoadingOlder(false);
    }
  }, [loaded, loadingOlder, missionId]);

  useEffect(() => {
    void refresh();
    const onMission = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as { missionId?: unknown };
        if (data.missionId === missionId) void refresh();
      } catch { /* a malformed frame names no mission */ }
    };
    const offTurn = sseOn('turn_complete', onMission);
    const offComplete = sseOn('mission_complete', onMission);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, EGRESS_POLL_MS);
    return () => { offTurn(); offComplete(); window.clearInterval(timer); };
  }, [missionId, refresh]);

  if (!loaded) {
    if (failure) return <EgressFailureNotice failure={failure} onRetry={() => void refresh()} />;
    return <p className="px-3 py-4 text-[12px] text-muted-foreground">{t('missionEgress.loading')}</p>;
  }

  const { head, rows, hasMore } = loaded;
  const fresh = newHostSet(head);
  const hosts = orderHosts(head.hosts, fresh);
  const empty = rows.length === 0 && hosts.length === 0;
  const off = head.proxy?.mode === 'off';

  return (
    <div className="space-y-3 p-3" data-egress-view={missionId}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-muted-foreground">
          {!(off && empty) && t('missionEgress.connectionsCount', { count: rows.length })}
        </span>
        {onOpenInSplit && (
          <IconButton label={t('missionEgress.openInSplit')} onClick={onOpenInSplit}>
            <Columns2 className="size-3.5" aria-hidden />
          </IconButton>
        )}
        <IconButton label={t('missionEgress.refresh')} onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden />
        </IconButton>
      </div>

      {off && (
        // Not a warning: it is the default state. It replaces the empty state, which would read as "reached nothing".
        <div className="space-y-1.5 rounded-lg bg-muted/30 px-3 py-3" data-egress-proxy="off">
          <p className="text-[12px] font-medium text-foreground">{t('missionEgress.offTitle')}</p>
          <p className="text-[11px] text-muted-foreground">{t('missionEgress.offBody')}</p>
          {!empty && <p className="text-[11px] text-muted-foreground">{t('missionEgress.offHistory')}</p>}
        </div>
      )}
      {head.proxy?.mode === 'log' && !head.proxy.listening && <Notice data-egress-proxy="down">{t('missionEgress.notListening')}</Notice>}
      {failure && <p className="text-[11px] text-destructive" role="alert">{t(`missionEgress.error.${failure}`)}</p>}

      {off && empty ? null : empty ? (
        <div className="space-y-1.5 rounded-lg bg-muted/30 px-3 py-3" data-egress-empty="">
          <p className="text-[12px] text-foreground">{t('missionEgress.empty')}</p>
          <p className="text-[11px] text-muted-foreground">{t('missionEgress.limit')}</p>
        </div>
      ) : (
        <>
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-medium text-muted-foreground">{t('missionEgress.hosts')}</h3>
            <ul className="space-y-1">
              {hosts.map((host) => {
                const isNew = fresh.has(host.host);
                return (
                  <li
                    key={host.host}
                    data-egress-host={host.host}
                    data-new={isNew ? 'true' : undefined}
                    className={cn('rounded-md px-2 py-1.5', isNew ? 'bg-[hsl(var(--warning)/0.1)]' : 'bg-muted/30')}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-[12px] font-medium" title={host.host}>{host.host}</span>
                      {isNew && (
                        <span
                          className="shrink-0 rounded bg-[hsl(var(--warning)/0.18)] px-1.5 py-0.5 text-[9.5px] uppercase leading-none tracking-wide text-[hsl(var(--warning))]"
                          title={t('missionEgress.newHostHint')}
                        >
                          {t('missionEgress.newHost')}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {t('missionEgress.connectionsCount', { count: host.connections })}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10.5px] tabular-nums text-muted-foreground">
                      <Bytes out={host.bytes_out} received={host.bytes_in} />
                      {host.failures > 0 && <span className="text-destructive">{t('missionEgress.failures', { count: host.failures })}</span>}
                      <span title={formatDateTime(host.last_at)} suppressHydrationWarning>{fmtRelativeShort(host.last_at)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-[11px] font-medium text-muted-foreground">{t('missionEgress.connections')}</h3>
            <ul className="space-y-0.5">
              {rows.map((row) => (
                <ConnectionRow key={row.id} row={row} />
              ))}
            </ul>
            {hasMore && (
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingOlder}
                className="w-full rounded-md bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
              >
                {loadingOlder ? t('missionEgress.loadingOlder') : t('missionEgress.loadOlder')}
              </button>
            )}
          </section>

          <p className="text-[10.5px] text-muted-foreground/80">
            {t('missionEgress.limit')}{' '}
            {t('missionEgress.retention', {
              count: head.retention.per_mission,
              days: Math.round(head.retention.max_age_ms / 86_400_000),
            })}
          </p>
        </>
      )}
    </div>
  );
}

function ConnectionRow({ row }: { row: EgressConnection }): ReactElement {
  const failed = connectionFailed(row);
  return (
    <li data-egress-connection={row.id} className="rounded-md px-2 py-1 transition-colors hover:bg-muted/40">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{row.method}</span>
        <span className="min-w-0 truncate text-[12px]" title={`${row.host}:${row.port}`}>
          {row.host}<span className="text-muted-foreground">:{row.port}</span>
        </span>
        <span
          className={cn('ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums leading-none', failed ? 'bg-destructive/10 text-destructive' : 'bg-muted/50 text-muted-foreground')}
          title={t('missionEgress.status')}
        >
          {row.status || '—'}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10.5px] tabular-nums text-muted-foreground">
        <Bytes out={row.bytes_out} received={row.bytes_in} />
        <span>{formatDuration(row.duration_ms)}</span>
        <span title={formatDateTime(row.started_at)} suppressHydrationWarning>{fmtRelativeShort(row.started_at)}</span>
      </div>
      {row.error && <p className="mt-0.5 text-[10.5px] text-destructive">{t('missionEgress.upstreamError', { code: row.error })}</p>}
    </li>
  );
}

function Bytes({ out, received }: { out: number; received: number }): ReactElement {
  return (
    <>
      <span className="inline-flex items-center gap-0.5" title={t('missionEgress.sent')}>
        <ArrowUp className="size-3" aria-hidden />{fmtSize(out)}
      </span>
      <span className="inline-flex items-center gap-0.5" title={t('missionEgress.received')}>
        <ArrowDown className="size-3" aria-hidden />{fmtSize(received)}
      </span>
    </>
  );
}

function Notice({ children, ...rest }: { children: string; 'data-egress-proxy': string }): ReactElement {
  return (
    <p {...rest} className="rounded-md bg-[hsl(var(--warning)/0.1)] px-2.5 py-2 text-[11.5px] text-[hsl(var(--warning))]">
      {children}
    </p>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactElement }): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function EgressFailureNotice({ failure, onRetry }: { failure: EgressFailure; onRetry: () => void }): ReactElement {
  return (
    <div className="space-y-2 px-3 py-4" role="alert" data-egress-failure={failure}>
      <p className="text-[12px] text-muted-foreground">{t(`missionEgress.error.${failure}`)}</p>
      {failure === 'unavailable' && (
        <button type="button" onClick={onRetry} className="rounded-md bg-muted/40 px-2 py-1 text-[11px] hover:bg-muted/70">
          {t('missionEgress.retry')}
        </button>
      )}
    </div>
  );
}

/** The rail card: the conversation on screen. Outside a chat it paints nothing. */
export function EgressWidget(): ReactElement | null {
  const chat = useChatRail();
  const later = useAfterConversation();
  const bus = useIslandBus();
  if (!chat || !later) return null;
  const missionId = chat.currentMissionId;
  if (!missionId) return <p className="px-3 py-4 text-[12px] text-muted-foreground">{t('missionEgress.noMission')}</p>;
  const open = bus.present
    ? () => { openInIsland(egressIslandContent(missionId), { edge: bus.narrow ? 'center' : 'right' }); }
    : undefined;
  return <EgressView key={missionId} missionId={missionId} onOpenInSplit={open} />;
}

/** The island content: a mission named by its params, whatever chat is open. */
export function EgressIsland(): ReactElement | null {
  const { params, setTitle } = useIslandContent();
  const missionId = typeof params.missionId === 'string' ? params.missionId : null;
  useEffect(() => {
    setTitle(missionId ? t('islands.missionEgress.titleOf', { mission: missionId.slice(0, 8) }) : null);
  }, [missionId, setTitle]);
  if (!missionId) return null;
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <EgressView key={missionId} missionId={missionId} />
    </div>
  );
}
