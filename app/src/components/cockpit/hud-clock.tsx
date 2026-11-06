'use client';

import { useEffect, useState } from 'react';
import { formatDate } from '@/lib/intl';

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** "Thu 6 Nov" in the reader's language: `Intl` knows every language's day and month names. */
function formatDay(d: Date): string {
  return formatDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function HudClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // SSR fallback — render nothing until mounted to avoid hydration mismatch
  if (!now) return null;

  return (
    <div className="flex select-none flex-col items-end gap-0.5">
      <time
        dateTime={now.toISOString()}
        className="tabular-nums text-[28px] font-semibold leading-none tracking-[0.06em] text-primary"
      >
        {formatTime(now)}
      </time>
      <span className="tabular-nums text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground/60">
        {formatDay(now)}
      </span>
    </div>
  );
}
