'use client';

import React, { createContext, type ReactElement } from 'react';
import { SlotRegion } from './render';
import { settingsSlotForGroup } from './settings-slots';

export type ResourceMemoryInfo = {
  detectedRamGb: number;
  autoClassGb: number;
  presets: { ramGb: number; missionGb: number; dayGb: number; nightGb: number }[];
};

export const NativeSettingsContext = createContext<{
  resourceMemory: ResourceMemoryInfo | null;
  refresh: () => Promise<boolean>;
  /** False when the preset hides the advanced settings zone. Native panes that
   *  host advanced settings honor it so they stay consistent with the rows. */
  includeAdvanced?: boolean;
} | null>(null);

/**
 * Graft slot of a native settings category, painted after the product's
 * own rows. Weightless while empty: no frame, no reserved gap, no heading.
 */
export function NativeCategoryGraft({ group }: { group: string }): ReactElement | null {
  return <SlotRegion name={settingsSlotForGroup(group)} />;
}
