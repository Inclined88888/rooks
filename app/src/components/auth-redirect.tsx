'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { shouldRedirectOn401 } from '@/lib/auth';

function pathOf(input: RequestInfo | URL): string {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  try {
    return new URL(raw, window.location.origin).pathname;
  } catch {
    return raw;
  }
}

/**
 * When the UI proxy returns 401 (expired/missing session), send the
 * browser to `/login`. One place, not per page. Login's own 401 (bad
 * password) is excluded by `shouldRedirectOn401`.
 */
export function AuthRedirect() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const orig = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await orig(input, init);
      if (res.status === 401 && shouldRedirectOn401(pathname, pathOf(input))) {
        router.replace('/login?reason=expired');
      }
      return res;
    };
    return () => {
      window.fetch = orig;
    };
  }, [pathname, router]);

  return null;
}
