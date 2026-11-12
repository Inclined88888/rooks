'use client';

/**
 * The foot of the nav: the entries of `nav.footer`, above the settings gear.
 *
 * A control there belongs to the whole interface, not to a page — the machine
 * switcher of the Machines plugin (TODO #329). Like `nav.item`, an entry is a
 * component with no props: it reads the rail's state (collapsed or not, drawer
 * or rail) from `useNavChrome()`. A menu it opens keeps the rail expanded
 * with `useHoldNavExpanded(open)`.
 *
 * The pages the person sent to the bottom of the menu (`footer` of the menu
 * row, TODO #456) come first, the controls of `nav.footer` under them. In
 * "Customize the menu" those pages are edited in the main list, under its
 * "Bottom of the menu" boundary, so the foot only keeps the controls.
 *
 * While both are empty the nav paints nothing, not even a gap: a stock
 * install keeps its foot exactly as it was.
 */

import { NavChromeProvider, type NavChrome } from '@/components/nav-link';
import { isNavEditable, renderNavRows, useNavMenu } from '@/components/nav-items';
import type { NavLayout } from '@/lib/nav-order';
import { renderSlotEntries, useSlotEntries } from '@/lib/plugin-host/render';

export const NAV_FOOTER_SLOT = 'nav.footer';

const NO_MENU: NavLayout = { order: [], footer: null };

export function NavFooter({ expanded, forceLabel, holdExpanded, hidden, editing, stored = NO_MENU }: Pick<NavChrome, 'expanded' | 'forceLabel' | 'holdExpanded' | 'hidden' | 'editing'> & {
  /** The person's menu: its `footer` pages are painted here. */
  stored?: NavLayout;
}): React.ReactElement | null {
  const entries = useSlotEntries(NAV_FOOTER_SLOT);
  const menu = useNavMenu(stored);
  const pages = isNavEditable({ editing, expanded, forceLabel }) ? [] : renderNavRows(menu.footer, hidden ?? []);
  if (entries.length === 0 && pages.length === 0) return null;
  return (
    <div data-nav-footer="" className="flex shrink-0 flex-col gap-0.5 px-2 pt-1">
      <NavChromeProvider value={{ expanded, forceLabel, holdExpanded, hidden }}>
        {pages}
        {renderSlotEntries(entries)}
      </NavChromeProvider>
    </div>
  );
}
