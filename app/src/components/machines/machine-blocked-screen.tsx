'use client';

/**
 * What the interface shows instead of a remote machine's cockpit when that
 * machine cannot be used from here (TODO #329, P3d): unreachable, this
 * computer's access revoked there, a contract level this app does not drive,
 * or a machine the local daemon no longer vouches for. Chosen by the root
 * layout before anything is mounted (`lib/machines/active-machine.ts`), like
 * the licence lock: a cockpit wired to a dead machine would only fire
 * refusals. It calls nothing on that machine; the way back is local.
 */
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { BackToLocalButton } from '@/components/machines/back-to-local';
import { MIN_API_LEVEL } from '@/lib/machines/api-level';
import type { BlockReason } from '@/lib/machines/active-machine';
import { machinesSettingsPath } from '@/lib/machines/fleet';
import { t } from '@/lib/i18n';

export function MachineBlockedScreen({ name, reason, apiLevel }: {
  name: string | null;
  reason: BlockReason;
  apiLevel: number | null;
}): ReactElement {
  const machine = name ?? t('machines.blocked.unnamed');
  const vars = { name: machine, level: apiLevel ?? '?', min: MIN_API_LEVEL, settingsPath: machinesSettingsPath() };
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="grid w-full max-w-lg gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('machines.title')}</div>
          <h1 className="mt-1 text-[22px] font-semibold -tracking-[0.01em]">{t(`machines.blocked.title.${reason}`, vars)}</h1>
          <p className="mt-2 max-w-[65ch] text-sm leading-snug" role="alert">{t(`machines.blocked.body.${reason}`, vars)}</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <BackToLocalButton />
          {reason !== 'incompatible' && reason !== 'unknown' && (
            <Button type="button" variant="ghost" size="sm" onClick={() => { window.location.reload(); }}>
              {t('machines.blocked.retry')}
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}
