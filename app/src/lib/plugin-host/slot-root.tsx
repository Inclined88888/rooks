'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  isLayoutSurfaceAllowed,
  isModuleOn,
  useCapabilities,
  type Capabilities,
} from '@/lib/capabilities';
import { UI_LAYOUT_MODULE } from '@/plugins-client/ui-layout';
import { AppFrame } from './ui-layout';
import { PluginBoundary } from './plugin-boundary';
import { register, slotEntries, slotKind, slotVersion, subscribeSlots } from './slots';
import { NEXT_ROUTER_KEY } from './page-slot';
import { ModulePageGate } from './module-page-gate';
import { t } from '@/lib/i18n';

/**
 * Default occupant of the boot `root` slot. The chrome lives here, not in
 * the bundled half: `mountBundledClients` only contributes the home nav
 * entry. Gating that half (T.5b) left AppFrame in place for a viewer
 * without `layout:ui-layout`. Both curtains are required (T.5c).
 */
export function registerProductLayout(caps: Capabilities | null): (() => void) | undefined {
  if (!isModuleOn(caps, UI_LAYOUT_MODULE) || !isLayoutSurfaceAllowed(caps, UI_LAYOUT_MODULE)) return;
  return register({ slot: 'root', pluginId: UI_LAYOUT_MODULE, fallback: true }, AppFrame);
}

/**
 * The `(main)` frame: registers `AppFrame` on `root`, hands the Next subtree
 * to the `page` slot, and paints the frame.
 *
 * What it deliberately does NOT do any more: declare the layout slots, mount
 * the bundled halves, watch the daemon. All three moved to `ClientPluginHost`
 * on the root layout, because pages outside `(main)` never render this
 * component and were left with an empty rail. Doing it here too would
 * duplicate every nav entry and open a second SSE stream.
 *
 * `AppFrame` is registered WITHOUT `children`: leaving `(main)` disposes it,
 * and a declarant that goes away takes its slots — and their occupants — with
 * it. The host outlives the route, so it is the declarant.
 */
export function SlotRoot({ children }: { children: React.ReactNode }): React.ReactElement {
  const caps = useCapabilities();
  const uiLayoutOn = isModuleOn(caps, UI_LAYOUT_MODULE)
    && isLayoutSurfaceAllowed(caps, UI_LAYOUT_MODULE);
  useSyncExternalStore(subscribeSlots, slotVersion, slotVersion);
  const pageDeclared = slotKind('page') === 'keyed';

  useEffect(() => registerProductLayout(caps), [caps, uiLayoutOn]);
  useEffect(() => {
    if (!slotEntries('root').length || !pageDeclared) return;
    const Page = () => <ModulePageGate>{children}</ModulePageGate>;
    try { return register({ slot: 'page', pluginId: 'next-router', key: NEXT_ROUTER_KEY }, Page); } catch { return; }
  }, [children, pageDeclared]);

  const root = slotEntries('root')[0];
  if (!root) return <div className="p-6 text-sm text-muted-foreground">{t('slotRoot.noLayout')}</div>;
  const Root = root.Component;
  return <PluginBoundary pluginId={root.pluginId}><Root /></PluginBoundary>;
}
