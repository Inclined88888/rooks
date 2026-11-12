'use client';

/**
 * Time left before a pending card of an autonomous mission expires. Without it
 * the user only learnt of the delay when the card turned "expired" under them.
 */
import { useEffect, useState } from 'react';
import { formatCountdown } from '@/lib/countdown';
import { t } from '@/lib/i18n';

export function PermissionCountdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = expiresAt - now;
  return (
    <span
      data-testid="permission-countdown"
      title={t('chatPage.permExpiresHint')}
      className={left < 60_000 ? 'text-[10.5px] tabular-nums text-[hsl(var(--warning))]' : 'text-[10.5px] tabular-nums text-muted-foreground'}
    >
      {left > 0 ? t('chatPage.permExpiresIn', { time: formatCountdown(left) }) : t('chatPage.permExpiring')}
    </span>
  );
}
