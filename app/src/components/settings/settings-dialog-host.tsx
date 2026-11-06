'use client';

import type { ReactElement } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { SETTINGS_PARAM } from '@/lib/settings-navigation';

/**
 * The dialog and its ~20 panes are fetched the first time `?settings=` shows
 * up, not with the root layout every page loads (docs/BUNDLE-SIZE.md). The
 * dialog itself still decides what an unknown target or a viewer without the
 * surface gets: this gate only checks that a target is asked for at all.
 */
const SettingsDialog = dynamic(
  () => import('./settings-dialog').then((m) => m.SettingsDialog),
  { ssr: false },
);

export function SettingsDialogHost(): ReactElement | null {
  const searchParams = useSearchParams();
  if (searchParams.get(SETTINGS_PARAM) === null) return null;
  return <SettingsDialog />;
}
