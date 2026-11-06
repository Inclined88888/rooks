'use client';

/**
 * Helper for a module registering a cockpit-style widget.
 *
 * Same shape as `registerNavItem`: the zone check is kept identical to the
 * hard-coded table it replaces — a zone hidden in `timon.config.json`
 * (editorial) or whose module is off (technical) simply never registers, so
 * the card is absent from the rails AND from the palette, while its stored
 * placement survives untouched.
 *
 * `frame: 'none'` is what makes a *verbatim* extraction possible: the tiles
 * paint their own `Tile`, with a live subtitle the host's generic frame could
 * not show, and a body (3D canvas, scrolling lists, inputs) where a handle
 * laid over on hover would eat the interactions. They therefore keep receiving
 * `WidgetProps`, exactly as when they were entries of `widget-registry.tsx`.
 */

import type { ComponentType } from 'react';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import type { WidgetOptions } from '@/lib/plugin-host/slots';
import { isWidgetSurfaceAllowed } from '@/lib/capabilities';
import type { BundledClientContext } from './types';

export type WidgetEntry = {
  /**
   * Registration key. It sets both the placement id (`plugin:<module>:<key>`)
   * and the config zone below.
   */
  key: string;
  /** Zone id (plan §3.6), i.e. `cockpit.<key>` for every tile of the product. */
  zone?: string;
  widget: WidgetOptions;
  Component: ComponentType<WidgetProps>;
};

export function registerWidget(ctx: BundledClientContext, entry: WidgetEntry): void {
  if (entry.zone && !ctx.zoneVisible(entry.zone)) return;
  if (!isWidgetSurfaceAllowed(ctx.caps, ctx.id, entry.key)) return;
  ctx.register(
    { slot: 'cockpit.widget', key: entry.key, widget: entry.widget },
    // The slot registry only types components without props — the ordinary
    // case, the host framing the card itself. A widget that took over its
    // frame gets `WidgetProps`; the conversion lives here, once.
    entry.Component as ComponentType,
  );
}
