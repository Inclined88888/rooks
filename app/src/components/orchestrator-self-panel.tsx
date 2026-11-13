'use client';

/**
 * Mini-widget of the chat's right rail, under the Docker block — specific to
 * the `rooks` project (the orchestrator itself, host mode, not a container).
 *
 * Restart and rebuild kill ALL in-flight missions (see the project's
 * CLAUDE.md: never from an agentic task, only an explicit human gesture) —
 * hence the two-click confirmation rather than a direct button like the
 * neighboring Docker block.
 */

import { useCallback, useEffect, useState } from 'react';
import { Hammer, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { fmtRelativeShort } from '@/components/chat/chat-format';

type OrchestratorStatus = {
  active: string;
  sub: string | null;
  since: number | null;
  memoryCurrentBytes: number | null;
  building: boolean;
  buildError: string | null;
};

const POLL_MS = 4000;
/** Window during which a first click stays "armed" before resetting —
 *  short enough that a later accidental click doesn't trigger an
 *  unwanted restart. */
const CONFIRM_WINDOW_MS = 4000;

export function OrchestratorSelfPanel({ slug }: { slug: string | null }) {
  const [s, setS] = useState<OrchestratorStatus | null>(null);
  const [busy, setBusy] = useState<'restart' | 'rebuild' | null>(null);
  const [confirm, setConfirm] = useState<'restart' | 'rebuild' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/orchestrator/self', { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { orchestrator?: OrchestratorStatus };
      if (j.orchestrator) setS(j.orchestrator);
    } catch {
      // During a restart the process is down for a few seconds: a failed
      // poll here is expected, not an outage — silent like the Docker block.
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), CONFIRM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [confirm]);

  const run = useCallback(
    async (action: 'restart' | 'rebuild') => {
      if (confirm !== action) {
        setConfirm(action);
        return;
      }
      setConfirm(null);
      setBusy(action);
      setErr(null);
      try {
        const r = await fetch(`/api/ui/orchestrator/self/${action}`, { method: 'POST' });
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok && j.error) setErr(j.error);
      } catch {
        // `restart` responds then kills the process writing the response: a
        // failed fetch here is the normal flow, not a failure.
      } finally {
        setBusy(null);
        load();
      }
    },
    [confirm, load],
  );

  if (slug !== 'rooks' || !s) return null;

  const dotClass = s.building
    ? 'bg-amber-400'
    : s.active === 'active'
      ? 'bg-emerald-400'
      : s.active === 'failed'
        ? 'bg-red-400'
        : 'bg-muted-foreground/40';

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-end gap-2">
        <span className={`size-1.5 rounded-full ${dotClass}`} aria-hidden />
      </div>

      <div className="grid grid-cols-[68px_1fr] gap-y-1.5 text-[12px]">
        <span className="text-muted-foreground">{t('orchestratorSelf.state')}</span>
        <span className="text-[11px]">{s.building ? t('orchestratorSelf.rebuilding') : s.active}</span>

        {s.since != null && (
          <>
            <span className="text-muted-foreground">{t('orchestratorSelf.since')}</span>
            <span className="tabular-nums text-[11px]" suppressHydrationWarning>
              {fmtRelativeShort(s.since)}
            </span>
          </>
        )}

        {s.memoryCurrentBytes != null && (
          <>
            <span className="text-muted-foreground">{t('orchestratorSelf.mem')}</span>
            <span className="tabular-nums text-[11px]">
              {Math.round(s.memoryCurrentBytes / 1024 / 1024)} MB
            </span>
          </>
        )}
      </div>

      {err && <p className="mt-2 break-words text-[11.5px] text-red-400">{err}</p>}
      {s.buildError && (
        <p /* code-font: compiler error output */ className="mt-2 whitespace-pre-wrap break-words font-mono text-[10.5px] text-red-400">
          {t('orchestratorSelf.build')}: {s.buildError}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className={`h-7 gap-1 px-2 text-[11px] ${
            confirm === 'restart' ? 'border-amber-400/70 text-amber-500' : ''
          }`}
          disabled={busy !== null || s.building}
          onClick={() => run('restart')}
          title={t('orchestratorSelf.restartTitle')}
        >
          <RotateCw className={`size-3 ${busy === 'restart' ? 'animate-spin' : ''}`} />
          {confirm === 'restart' ? t('orchestratorSelf.confirm') : busy === 'restart' ? t('orchestratorSelf.restarting') : t('orchestratorSelf.restart')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={`h-7 gap-1 px-2 text-[11px] ${
            confirm === 'rebuild' ? 'border-amber-400/70 text-amber-500' : ''
          }`}
          disabled={busy !== null || s.building}
          onClick={() => run('rebuild')}
          title={t('orchestratorSelf.rebuildTitle')}
        >
          <Hammer className={`size-3 ${s.building ? 'animate-pulse' : ''}`} />
          {confirm === 'rebuild' ? t('orchestratorSelf.confirm') : s.building ? t('orchestratorSelf.building') : t('orchestratorSelf.rebuild')}
        </Button>
      </div>
    </div>
  );
}
