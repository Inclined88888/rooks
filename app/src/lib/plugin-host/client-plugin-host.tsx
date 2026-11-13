'use client';

/**
 * The mounting point of everything that occupies a slot: the layout's own
 * slots, the client halves of the bundled modules, and the third-party
 * bundles served by the daemon.
 *
 * Lives on the ROOT layout, not on `(main)`. `/agents`, `/multichat`,
 * `/chat`, `/notifications` and `/events` render their own `TopBar` (a
 * full-screen canvas has no room for the app frame), so they never go
 * through `SlotRoot`. Until this host existed, nobody declared `nav.item`
 * on those routes and nobody mounted the halves that fill it: the rail was
 * painted, and empty. Wrapping those pages in `AppFrame` instead would give
 * them two chromes.
 *
 * The split with `SlotRoot` is deliberate. `SlotRoot` owns what only makes
 * sense inside `(main)`: registering `AppFrame` on `root`, handing the Next
 * subtree to the `page` slot, and painting the frame. This host owns what
 * must survive leaving `(main)` — which is why `AppFrame` no longer carries
 * `children: UI_LAYOUT_CHILD_SLOTS`. Were it still the declarant, navigating
 * to `/agents` would dispose it, collapse `nav.item` with it, and this host's
 * effects would not re-run to rebuild them.
 */

import { useEffect } from 'react';
import { isModuleOn, useCapabilities } from '@/lib/capabilities';
import { mountBundledClients } from '@/plugins-client/mount';
import { syncClientPlugins, watchClientPlugins } from './loader';
import { declareSlot, slotKind } from './slots';
import { UI_LAYOUT_CHILD_SLOTS } from './ui-layout';

/** Owner passed to `declareSlot`: only what this host declared, it collapses. */
export const LAYOUT_SLOTS_OWNER = 'client-plugin-host';

/**
 * Declares the layout slots that are still missing, and returns the disposer
 * for those — and only those.
 *
 * `declareSlot` throws on a name already taken, so the guard is what lets a
 * second host (a chat opened in its own window, a test) coexist with the
 * first instead of bringing the page down. Same pattern as `chat-rails` and
 * the composer; no counter is needed here because a host that declared
 * nothing disposes nothing, and `collapseSlot` checks the owner.
 */
export function declareLayoutSlots(): () => void {
  const declared: Array<() => void> = [];
  for (const [name, kind] of Object.entries(UI_LAYOUT_CHILD_SLOTS)) {
    if (slotKind(name) === null) declared.push(declareSlot(name, kind, LAYOUT_SLOTS_OWNER));
  }
  return () => { for (const dispose of declared.reverse()) dispose(); };
}

export function ClientPluginHost(): null {
  const caps = useCapabilities();
  const uiLayoutOn = isModuleOn(caps, '@rooks/ui-layout');

  // Declared before anything is mounted into them: effects of one component
  // run in declaration order, so the two below always find their slots.
  // Switching `ui-layout` off collapses them, taking their occupants along —
  // a third-party `root` that wants other slots declares its own.
  useEffect(() => {
    if (!uiLayoutOn) return;
    return declareLayoutSlots();
  }, [uiLayoutOn]);

  // One EventSource for the whole app. It used to live in `SlotRoot`, which
  // would have opened a second one here.
  useEffect(() => watchClientPlugins(), []);
  useEffect(() => { void syncClientPlugins(); }, [uiLayoutOn]);

  // Re-run on every capability change: a module switched off must lose its
  // surfaces, which is the point of owning them per module.
  // Not gated on ui-layout: `@rooks/ui-theme` occupies a boot slot, and
  // turning the chrome off must not take the palette with it
  // (MULTI-THEME.md §1.3). A half that targets a missing layout child
  // throws and is isolated by mountBundledClients.
  useEffect(() => {
    return mountBundledClients(caps);
  }, [caps, uiLayoutOn]);

  return null;
}
