'use client';

/**
 * Keeps the page on screen as the last page of the active machine
 * (`lib/machines/last-route.ts`), so a switch back to it lands there. Every
 * in-app navigation counts, the chat's `history.pushState` included: Next
 * keeps `useSearchParams` in step with it.
 */
import { useEffect } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { rememberRoute } from '@/lib/machines/last-route';

export function LastRouteRecorder(): null {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? '';
  useEffect(() => {
    if (pathname) rememberRoute(search ? `${pathname}?${search}` : pathname);
  }, [pathname, search]);
  return null;
}
