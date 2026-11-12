'use client';

/**
 * One row of the main nav, shared by the rail and the mobile drawer.
 *
 * Extracted from `vertical-nav.tsx` so that a module registers its own entry
 * (`nav.item`) without recopying the chrome: the collapsed/expanded state,
 * the active-route rule and the spacing belong to the nav, not to the module.
 * The state travels by context — a slot entry is a component with no props.
 */

import Link from 'next/link';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { isNavItemActive } from '@/lib/nav-active';
import { useOpenInNewWindow } from '@/lib/open-window';

export type NavChrome = {
  /** The rail shows labels (hovered or pinned). */
  expanded: boolean;
  /** The drawer always shows them: there is no hover on a touch screen. */
  forceLabel: boolean;
  /** Pages taken out of the menu (`lib/nav-hidden.ts`). */
  hidden?: readonly string[];
  /** "Customize the menu": every page shows, each with its grip and its eye (`NavItems`). */
  editing?: boolean;
  onToggleHidden?: (href: string) => void;
  /**
   * Set by `NavItems` around an entry it wraps in an editor row: the row owns
   * the grip and the eye, the entry only shows what it is (no link).
   */
  editRow?: boolean;
  /**
   * Keeps the rail expanded until the returned release is called. Given by
   * the rail only: the drawer has nothing to fold. Read through
   * `useHoldNavExpanded`, not called directly.
   */
  holdExpanded?: () => () => void;
};

const NavChromeContext = createContext<NavChrome>({ expanded: false, forceLabel: false });

export const NavChromeProvider = NavChromeContext.Provider;

export function useNavChrome(): NavChrome {
  return useContext(NavChromeContext);
}

/**
 * The rail's side of `holdExpanded`: how many menus opened from it are still
 * shown. A Radix menu is modal and portalled — it turns the body's pointer
 * events off and paints outside the rail —, so the rail sees the pointer leave,
 * folds, moves the trigger, the menu follows, the pointer enters it again (a
 * portal is still the rail's child for React) and the rail unfolds: a loop.
 * `onRelease` runs when the last menu goes, for the rail to re-read its hover.
 */
export function useNavExpandedHolds(onRelease?: () => void): { held: boolean; holdExpanded: () => () => void } {
  const [holds, setHolds] = useState(0);
  const releaseRef = useRef(onRelease);
  releaseRef.current = onRelease;
  // Stable: a menu holds from an effect keyed on it, and a new identity at
  // every render would release and hold again forever.
  const holdExpanded = useCallback(() => {
    setHolds((n) => n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setHolds((n) => n - 1);
    };
  }, []);
  const held = holds > 0;
  const wasHeld = useRef(false);
  useEffect(() => {
    if (wasHeld.current && !held) releaseRef.current?.();
    wasHeld.current = held;
  }, [held]);
  return { held, holdExpanded };
}

/** Keeps the rail expanded while `open` is true: for a menu opened from the nav. */
export function useHoldNavExpanded(open: boolean): void {
  const { holdExpanded } = useNavChrome();
  useEffect(() => (open && holdExpanded ? holdExpanded() : undefined), [open, holdExpanded]);
}

// `px-3`: the collapsed rail is 56px, minus the 2×8px of its padding is a 40px
// row, and 12 + 16 (the icon) + 12 centres the icon in it. It was 15px while the
// rail still had a 1px border and a looser padding.
export function NavLink({
  href,
  labelKey,
  label: givenLabel,
  icon: Icon,
  onClick,
  active: activeOverride,
  activeRoutes,
}: {
  href: string;
  labelKey?: string;
  /** A label the person wrote (a named arrangement): shown as is, never looked up. */
  label?: string;
  icon: LucideIcon;
  /** Opens a surface in place (a dialog) instead of following `href`, which
   *  stays for a middle click or a new tab. */
  onClick?: () => void;
  /** For an entry whose surface is not a route. */
  active?: boolean;
  /** Other routes that light this entry, for a route with no entry of its own. */
  activeRoutes?: readonly string[];
}): React.ReactElement | null {
  const pathname = usePathname();
  const router = useRouter();
  const { expanded, forceLabel, hidden, editRow } = useContext(NavChromeContext);
  const active = activeOverride ?? isNavItemActive(pathname, href, activeRoutes);
  const showLabel = forceLabel || expanded;
  const label = givenLabel ?? (labelKey ? t(labelKey) : href);
  const isHidden = hidden?.includes(href) ?? false;
  // Desktop app: Shift+click or a middle click opens the page in a new window
  // (V5), what a browser does with a link. The shell denies the window the page
  // would ask for itself, so the gesture goes through the bridge instead.
  const openWindow = useOpenInNewWindow();
  if (editRow) {
    return (
      <span className={cn('flex items-center gap-3 overflow-hidden whitespace-nowrap px-3 py-1.5 text-[12.5px]', isHidden ? 'text-muted-foreground' : 'text-foreground')}>
        <Icon className="size-4 shrink-0" />
        <span className={cn('min-w-0 flex-1 truncate', isHidden && 'line-through')}>{label}</span>
      </span>
    );
  }
  if (isHidden) return null;
  return (
    <Link
      href={href}
      // Not on sight: the nav renders every route at once, and their ~20
      // prefetches took the six connections a page load has while the page
      // itself was still waiting for its data. On intent instead, which
      // leaves the click as fast as before.
      prefetch={false}
      onMouseEnter={() => router.prefetch(href)}
      onFocus={() => router.prefetch(href)}
      onClick={onClick || openWindow ? (e) => {
        if (openWindow && e.shiftKey && e.button === 0 && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          void openWindow(href);
          return;
        }
        if (!onClick || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onClick();
      } : undefined}
      onAuxClick={openWindow ? (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        void openWindow(href);
      } : undefined}
      title={showLabel ? undefined : label}
      className={cn(
        'flex h-[30px] items-center gap-3 overflow-hidden whitespace-nowrap rounded-[6px] px-3 text-[13px] no-underline transition-colors duration-150',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span>{label}</span>
    </Link>
  );
}

/**
 * The chrome's separator between the main entries and the secondary ones,
 * registered with the key `---` (`NAV_SEPARATOR`): `NavItems` paints it as a
 * separator row the person may move or remove. A gap, never a drawn rule
 * (AGENTS.md rule 16); this component only shows where a host paints the slot raw.
 */
export function NavDivider(): React.ReactElement {
  return <div aria-hidden className="h-3 shrink-0" />;
}
