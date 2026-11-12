'use client';

import { Settings } from 'lucide-react';
import { NavLink } from '@/components/nav-link';
import { isPageSurfaceAllowed, useCapabilities } from '@/lib/capabilities';
import { useSettingsNavigation } from '@/lib/settings-navigation';

/**
 * The gear, alone at the very foot of the nav. Native chrome rather than a
 * `nav.item`: its place is fixed (last, under every plugin entry), and it is
 * the way into the account actions too.
 */
export function SettingsNavLink({ onOpen }: { onOpen?: () => void }): React.ReactElement | null {
  const caps = useCapabilities();
  const { open } = useSettingsNavigation();
  // Fail closed while caps load: flashing the row then taking it away is
  // worse than a brief hole in the rail.
  if (caps === null || !isPageSurfaceAllowed(caps, '/settings')) return null;
  return (
    <NavLink
      href="/settings"
      labelKey="nav.settings"
      icon={Settings}
      onClick={() => { onOpen?.(); open(); }}
    />
  );
}
