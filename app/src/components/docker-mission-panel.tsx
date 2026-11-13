'use client';

/**
 * Docker block of the chat's right rail, next to the Grepai and Git blocks.
 *
 * What one wants to see without leaving the conversation: is the project's
 * stack up, on which local URL, and which service fell. The three gestures
 * (start / restart / stop) are there too — they are nearly always the first
 * thing done when an agent reports "the site does not answer".
 *
 * The block disappears when the project has no container: unlike a missing
 * grepai index, not using Docker is not a gap worth flagging.
 *
 * Markup modelled on the Mission block of `chat-client` (same `<section>`,
 * same 68px/1fr grid) so that the rail's blocks stay aligned.
 */

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Hammer, Play, RotateCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';

type DockerState = 'no-cwd' | 'no-docker' | 'none' | 'running' | 'partial' | 'stopped';

type Container = {
  id: string;
  name: string;
  service: string | null;
  state: string;
  health: string | null;
  started_at: number | null;
  url: string | null;
  ports: string[];
  building: boolean;
  build_error: string | null;
};

type Docker = {
  slug: string;
  state: DockerState;
  cwd: string | null;
  project: string | null;
  containers: Container[];
  url: string | null;
  building: boolean;
  build_error: string | null;
};

/** Same cadence as the neighbouring Grepai block. */
const POLL_MS = 4000;

export function DockerMissionPanel({ slug }: { slug: string | null }) {
  const [d, setD] = useState<Docker | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!slug) return;
    try {
      const r = await fetch(`/api/ui/docker/${encodeURIComponent(slug)}`, { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { docker?: Docker };
      if (j.docker) setD(j.docker);
    } catch {
      /* Silent: one missed 4 s poll must not break the chat rail. */
    }
  }, [slug]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const act = useCallback(
    async (action: 'start' | 'stop' | 'restart' | 'rebuild', container?: string) => {
      if (!d) return;
      setBusy(container ? `${action}:${container}` : action);
      setErr(null);
      try {
        const r = await fetch(`/api/ui/docker/${encodeURIComponent(d.slug)}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(container ? { container } : {}),
        });
        // `rebuild` answers at once ({started:true}) without a `docker` object —
        // the next poll (4 s) brings `building: true`.
        const j = (await r.json()) as { docker?: Docker; error?: string };
        if (r.ok && j.docker) setD(j.docker);
        else if (j.error) setErr(j.error);
      } catch {
        /* the failure shows at the next poll: the state will not move */
      } finally {
        setBusy(null);
        load();
      }
    },
    [d, load],
  );

  // Nothing to watch: unknown project, no working directory, or not a single
  // container. An unreachable daemon stays shown: that is an outage, not an
  // absence.
  if (!slug || !d || d.state === 'no-cwd' || d.state === 'none') return null;

  if (d.state === 'no-docker') {
    return (
      <div className="p-3">
        <PanelHeader dotClass="bg-red-400" />
        <p className="text-[11.5px] text-muted-foreground/70">
          {t('dockerPanel.unreachable')}
        </p>
      </div>
    );
  }

  const total = d.containers.length;
  const up = d.containers.filter((c) => c.state === 'running').length;
  const running = d.state === 'running';

  return (
    <div className="p-3">
      <PanelHeader
        dotClass={
          running ? 'bg-emerald-400' : d.state === 'partial' ? 'bg-amber-400' : 'bg-muted-foreground/40'
        }
      />

      <div className="grid grid-cols-[68px_1fr] gap-y-1.5 text-[12px]">
        <span className="text-muted-foreground">{t('dockerPanel.stack')}</span>
        <span className="truncate text-[11px]">{d.project ?? d.slug}</span>

        <span className="text-muted-foreground">{t('dockerPanel.state')}</span>
        <span className="tabular-nums text-[11px]">
          {t('dockerPanel.upCount', { up, total })}
        </span>

        {d.url && (
          <>
            <span className="text-muted-foreground">{t('dockerPanel.url')}</span>
            <a
              href={d.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 truncate text-[11px] text-primary hover:underline"
            >
              <span className="truncate">{d.url.replace(/^https?:\/\//, '')}</span>
              <ExternalLink className="size-2.5 shrink-0" />
            </a>
          </>
        )}
      </div>

      <ul className="mt-2 flex flex-col gap-1">
        {d.containers.map((c) => {
          const on = c.state === 'running';
          return (
            <li key={c.id} className="flex items-center gap-1.5 text-[11px]">
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  c.health === 'unhealthy'
                    ? 'bg-red-400'
                    : on
                      ? 'bg-emerald-400'
                      : 'bg-muted-foreground/40'
                }`}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate" title={c.name}>
                {c.service ?? c.name}
              </span>
              <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/60">
                {c.building ? t('dockerPanel.building') : c.health && c.health !== 'healthy' ? c.health : c.state}
              </span>
              {c.service && (
                <button
                  type="button"
                  onClick={() => act('rebuild', c.id)}
                  disabled={busy !== null || c.building}
                  title={c.build_error ? t('dockerPanel.rebuildFailed', { error: c.build_error }) : t('dockerPanel.rebuildContainer', { name: c.name })}
                  className={`inline-flex size-[18px] shrink-0 items-center justify-center rounded border border-transparent transition-colors hover:border-border hover:text-foreground disabled:opacity-30 ${
                    c.build_error ? 'text-red-400' : 'text-muted-foreground/50'
                  }`}
                >
                  <Hammer className={`size-2.5 ${c.building ? 'animate-pulse' : ''}`} />
                </button>
              )}
              <button
                type="button"
                onClick={() => act(on ? 'restart' : 'start', c.id)}
                disabled={busy !== null || c.building}
                title={on ? t('dockerPanel.restartContainer', { name: c.name }) : t('dockerPanel.startContainer', { name: c.name })}
                className="inline-flex size-[18px] shrink-0 items-center justify-center rounded border border-transparent text-muted-foreground/50 transition-colors hover:border-border hover:text-foreground disabled:opacity-30"
              >
                {on ? <RotateCw className="size-2.5" /> : <Play className="size-2.5" />}
              </button>
            </li>
          );
        })}
      </ul>

      {err && <p className="mt-2 break-words text-[11.5px] text-red-400">{err}</p>}
      {d.build_error && (
        <p className="mt-2 break-words text-[11.5px] text-red-400">{t('dockerPanel.rebuildFailed', { error: d.build_error })}</p>
      )}

      {/* Icons + tooltip rather than labels: with three buttons, the text
       *  ("Stop" / "Restart" / "Rebuild") no longer fitted on a single line
       *  in the rail's width. */}
      <div className="mt-3 flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-7 flex-1 gap-1 px-0 text-[11px]"
          disabled={busy !== null || d.building}
          onClick={() => act(up > 0 ? 'stop' : 'start')}
          title={up > 0 ? t('dockerPanel.stop') : t('dockerPanel.start')}
        >
          {up > 0 ? <Square className="size-3" /> : <Play className="size-3" />}
          {up > 0
            ? (busy === 'stop' ? t('dockerPanel.stopping') : t('dockerPanel.stop'))
            : busy === 'start' ? t('dockerPanel.starting') : t('dockerPanel.start')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 shrink-0 px-0"
          disabled={busy !== null || up === 0 || d.building}
          onClick={() => act('restart')}
          title={t('dockerPanel.restart')}
        >
          <RotateCw className={`size-3 ${busy === 'restart' ? 'animate-spin' : ''}`} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 shrink-0 px-0"
          disabled={busy !== null || d.building}
          onClick={() => act('rebuild')}
          title={d.building ? t('dockerPanel.rebuilding') : t('dockerPanel.rebuildStack')}
        >
          <Hammer className={`size-3 ${d.building ? 'animate-pulse' : ''}`} />
        </Button>
      </div>
    </div>
  );
}

function PanelHeader({ dotClass }: { dotClass: string }) {
  return (
    <div className="mb-2 flex items-center justify-end gap-2">
      <span className={`size-1.5 rounded-full ${dotClass}`} aria-hidden />
    </div>
  );
}
