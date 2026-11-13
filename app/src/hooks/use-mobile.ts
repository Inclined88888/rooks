'use client';

import { useEffect, useState } from 'react';

/** Tailwind's `md` breakpoint: above it, the cockpit unfolds its side rails. */
export const MOBILE_MQ = '(max-width: 767px)';

/**
 * True on a mobile screen. Always `false` on the first render — `window`
 * does not exist on the server, and reading the width during render would
 * make hydration diverge.
 *
 * Use only for what a CSS media query cannot do: here, the inline height of a
 * resized widget. Everything about layout goes through the `md:` variants —
 * no flash, no JS.
 */
export function useMobile(query: string = MOBILE_MQ): boolean {
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const sync = () => setMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);

  return mobile;
}
