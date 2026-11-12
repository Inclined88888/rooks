'use client';

import React, { useMemo, useSyncExternalStore } from 'react';
import { PluginBoundary } from './plugin-boundary';
import { slotEntries, slotEntry, slotVersion, subscribeSlots } from './slots';
import type { SlotEntry } from './slots';

export function renderSlotEntries(entries: readonly SlotEntry[]): React.ReactElement[] {
  return entries.map(({ id, pluginId, Component }) => (
    <PluginBoundary key={id} pluginId={pluginId}><Component /></PluginBoundary>
  ));
}

/**
 * Entries registered in a slot, re-read whenever the registry changes.
 *
 * Exposed because a host sometimes needs to know whether a slot holds anything
 * before deciding how to paint itself, not just to render its entries.
 */
export function useSlotEntries(name: string): readonly SlotEntry[] {
  const version = useSyncExternalStore(subscribeSlots, slotVersion, slotVersion);
  // Stable between registry changes: `slotEntries` builds a new array on every
  // call, which fed `useMemo([entries])` consumers a new value each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => slotEntries(name), [name, version]);
}

/**
 * The entry a keyed slot holds under `entryKey`, re-read on every change of
 * the registry — a page plugin can land long after the host first painted.
 */
export function useSlotEntry(name: string, entryKey: string): SlotEntry | null {
  useSyncExternalStore(subscribeSlots, slotVersion, slotVersion);
  return slotEntry(name, entryKey);
}

/**
 * One entry of a keyed slot. Renders `fallback` (nothing by default) when the
 * key is free: a keyed slot is a set of destinations, and most of them are
 * empty on a stock install.
 */
export function SlotKeyed({
  name,
  entryKey,
  fallback = null,
}: {
  name: string;
  entryKey: string;
  fallback?: React.ReactNode;
}): React.ReactElement {
  const entry = useSlotEntry(name, entryKey);
  if (!entry) return <>{fallback}</>;
  const Component = entry.Component;
  return <PluginBoundary pluginId={entry.pluginId}><Component /></PluginBoundary>;
}

/**
 * The occupant of a `single` slot: the plugin that claimed it, or the default
 * the product registered (`RegisterOptions.fallback`).
 *
 * Both are entries of the registry, so the host paints one thing and never
 * has to know which of the two it is — that is what makes the composer
 * replaceable without the chat having to know about plugins.
 */
export function SlotSingle({ name }: { name: string }): React.ReactElement | null {
  const entry = useSlotEntries(name)[0];
  if (!entry) return null;
  const Component = entry.Component;
  return <PluginBoundary pluginId={entry.pluginId}><Component /></PluginBoundary>;
}

export function Slot({ name }: { name: string }): React.ReactElement {
  return <>{renderSlotEntries(useSlotEntries(name))}</>;
}

/**
 * Host for a widget zone: renders `children` wrapped in a container ONLY
 * when at least one entry is registered.
 *
 * A widget zone lives inside an existing surface (nav rail, right rail),
 * so it cannot afford to paint a border, a gap or a reserved width while
 * empty — that would show as a ghost frame on a stock install where no
 * plugin targets the zone. Returning `null` keeps the zone weightless
 * until something is actually placed in it.
 */
export function SlotRegion({
  name,
  className,
  label,
}: {
  name: string;
  className?: string;
  label?: string;
}): React.ReactElement | null {
  const entries = useSlotEntries(name);
  if (entries.length === 0) return null;
  return (
    <div className={className} aria-label={label} data-slot-region={name}>
      {renderSlotEntries(entries)}
    </div>
  );
}
