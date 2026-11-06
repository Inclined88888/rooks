'use client';

/**
 * "Back to this computer": drops the active machine and loads the interface
 * of the local daemon again, on this same origin. Shown wherever a remote
 * machine can leave the user stranded — unreachable, revoked, incompatible,
 * licence-locked — so it calls nothing on that machine: the switch is
 * answered by this app and the local daemon only.
 */
import { useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { fleetErrorKind, switchToLocal } from '@/lib/machines/fleet';
import { t } from '@/lib/i18n';

export function BackToLocalButton({ variant = 'default', size = 'sm', className }: {
  variant?: 'default' | 'outline' | 'ghost';
  size?: 'sm' | 'default';
  className?: string;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const back = async () => {
    setBusy(true);
    setError(null);
    const outcome = await switchToLocal();
    // A success reloads the document, or hides this page alive (desktop):
    // it must come back not busy.
    if (outcome.ok) { if (outcome.kept) setBusy(false); return; }
    setBusy(false);
    setError(t(`machines.errors.${fleetErrorKind(outcome)}`));
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <Button type="button" variant={variant} size={size} className={className} disabled={busy} onClick={() => void back()}>
        {t('machines.backToLocal')}
      </Button>
      {error && <span role="alert" className="text-[12px] text-destructive">{error}</span>}
    </span>
  );
}
