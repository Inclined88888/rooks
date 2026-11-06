'use client';

import { useEffect, type ReactElement } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { formatSettingsParam, legacyGroupTarget } from '@/lib/settings-layout';
import { SETTINGS_PARAM } from '@/lib/settings-navigation';

/**
 * `/settings` is no longer a page: Settings opens as a dialog over the
 * cockpit. Old links (`?group=<slug>`, bookmarks, the desktop menu) land on
 * the tab that now holds what they pointed to.
 */
export function SettingsRedirect(): ReactElement | null {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const group = searchParams.get('group');
    const param = searchParams.get(SETTINGS_PARAM)
      ?? (group ? formatSettingsParam(legacyGroupTarget(group)) : 'interface');
    router.replace(`/?${new URLSearchParams({ [SETTINGS_PARAM]: param }).toString()}`);
  }, [router, searchParams]);
  return null;
}
