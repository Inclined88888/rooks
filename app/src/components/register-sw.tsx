'use client';

import { useEffect } from 'react';

/**
 * Registers /sw.js exactly once on the client. Mounted from the root
 * layout so the registration happens on the very first paint regardless
 * of which route the user lands on.
 *
 * The stub worker exists purely to satisfy the Chrome / Brave install
 * heuristic on Android (see public/sw.js). It does no caching, so
 * everything keeps reaching the network normally — failures here are
 * not user-visible and should not block rendering.
 */
export function RegisterSW(): null {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => {
        // Surface in dev only — production users have no recourse and
        // a noisy console here is just noise.
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[sw] registration failed', err);
        }
      });
  }, []);
  return null;
}
