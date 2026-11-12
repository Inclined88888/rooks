'use client';

import { useMemo } from 'react';
import { ISLANDS_SUFFIX, presetIslandTree } from '@/lib/island-presets';
import type { CaptureHooks } from '@/lib/layout-presets';
import { useIslandContentTypes, type IslandContentType } from './island-content';

/** The capture hooks of the island workspace, for the types registered now. */
export function presetCaptureHooks(types: ReadonlyMap<string, IslandContentType>): CaptureHooks {
  const declared = new Map([...types].map(([id, type]) => [id, type.options]));
  return { [ISLANDS_SUFFIX]: (layout) => presetIslandTree(layout, declared) };
}

/**
 * What a preset of the view on screen drops from its rows. Read from the
 * `island.content` slot at the moment of the capture: a type a plugin
 * registers later declares its own volatile params without anyone listing
 * them here.
 */
export function usePresetCaptureHooks(): CaptureHooks {
  const types = useIslandContentTypes();
  return useMemo(() => presetCaptureHooks(types), [types]);
}
