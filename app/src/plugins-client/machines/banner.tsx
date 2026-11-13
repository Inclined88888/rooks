'use client';

/**
 * The notice a remote machine gets while it is driven (TODO #329, P3d):
 *
 *   - it stopped answering after the page loaded — the layout's own check
 *     only covers the load. Probed through the local daemon every 30 s while
 *     the page is visible; Retry reloads, "Back to this computer" leaves.
 *   - its contract level is unknown, or newer than this interface's: allowed,
 *     but said once per session (dismissible).
 *
 * A level below the minimum never gets here: the switch refuses it and the
 * layout blocks it.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { BackToLocalButton } from '@/components/machines/back-to-local';
import { apiLevelVerdict } from '@/lib/machines/api-level';
import { probeMachine, type FleetMachine } from '@/lib/machines/fleet';
import { machineSessionStorage } from '@/lib/machines/machine-storage';
import { t } from '@/lib/i18n';
import { updateFleetMachine } from './fleet-store';

export const PROBE_INTERVAL_MS = 30_000;
const DISMISSED_KEY = 'rooks.machines.levelNoticeDismissed';

function dismissedThisSession(): boolean {
  try {
    return machineSessionStorage()?.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function MachineBanner({ machineId, machine }: { machineId: string; machine: FleetMachine | null }): ReactElement | null {
  const [unreachable, setUnreachable] = useState(false);
  const [dismissed, setDismissed] = useState(dismissedThisSession);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const result = await probeMachine(machineId);
      if (stopped) return;
      // The local daemon itself not answering is not this machine's fault.
      if (!result.ok) return;
      updateFleetMachine(result.value.machine);
      setUnreachable(!result.value.reachable);
    };
    const timer = setInterval(() => { void check(); }, PROBE_INTERVAL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [machineId]);

  const name = machine?.name ?? t('machines.blocked.unnamed');
  const verdict = machine ? apiLevelVerdict(machine.api_level) : 'ok';
  const levelNotice = !dismissed && (verdict === 'unknown' || verdict === 'newer');
  if (!unreachable && !levelNotice) return null;

  const dismiss = () => {
    setDismissed(true);
    try { machineSessionStorage()?.setItem(DISMISSED_KEY, '1'); } catch { /* storage refused: dismissed for this page only */ }
  };

  return (
    <div
      role={unreachable ? 'alert' : 'status'}
      className="fixed bottom-4 left-1/2 z-40 flex w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl bg-popover px-4 py-3 text-[13px] text-popover-foreground shadow-elev-3"
    >
      <p className="m-0 min-w-0 flex-1 leading-snug">
        {unreachable
          ? t('machines.banner.unreachable', { name })
          : t(verdict === 'newer' ? 'machines.banner.apiNewer' : 'machines.banner.apiUnknown', { name })}
      </p>
      <div className="flex shrink-0 flex-wrap items-start gap-2">
        {unreachable ? (
          <>
            <BackToLocalButton />
            <Button type="button" size="sm" variant="ghost" onClick={() => { window.location.reload(); }}>{t('machines.banner.retry')}</Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="ghost" onClick={dismiss}>{t('machines.banner.dismiss')}</Button>
        )}
      </div>
    </div>
  );
}
