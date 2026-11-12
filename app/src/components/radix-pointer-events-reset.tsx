'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

// Radix portals (Dialog/Sheet/Select) sometimes set pointer-events:none
// on <body> and forget to clean it up if closing is interrupted
// (navigation, fast unmount). Result: every click dies until reload.
export function RadixPointerEventsReset() {
  const pathname = usePathname();
  useEffect(() => {
    if (document.body.style.pointerEvents === 'none') {
      document.body.style.pointerEvents = '';
    }
  }, [pathname]);
  return null;
}
