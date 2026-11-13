'use client';

/**
 * What a `model.picker` occupant is painted for (`docs/MODEL-PICKER.md` §7).
 *
 * The slot passes no props — an entry is registered once and painted by every
 * picker on screen — so each host (`ModelPickerPanel`, `ModelPickerPopover`)
 * puts its own value here and the occupant reads it with `useModelPicker()`.
 * Two pickers mounted at once (a composer per conversation, a task form, a
 * card) each wrap the same occupant in their own provider: nothing is shared
 * but the component.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { CatalogTarget } from '@/lib/catalog-target';
import type { PopoverAlign, PopoverPlacement } from '@/lib/popover-placement';
import type { ModelPick, ModelPickerFilter } from './picker-model';

export type ModelPickerMode = 'panel' | 'popover';

export type ModelPickerContextValue = {
  /** `panel`: flat in a form or a column. `popover`: inside the product's popover, which owns the anchoring, the focus and the closing. */
  mode: ModelPickerMode;
  /** The pair held by the form; `null` = the inherit entry (or nothing chosen yet). */
  value: ModelPick | null;
  /**
   * Hands a pick back to the form. In a popover it also closes it and gives
   * the focus back to the trigger, unless `popover.keepOpenOnPick`. Refused
   * (nothing happens) by `acceptsPick`: while `disabled`, for an account that
   * cannot run, a model `filter` rejects, `null` without an `inherit` entry —
   * the host enforces what the product's picker never offers.
   */
  onChange: (pick: ModelPick | null) => void;
  /** Show an "inherit / default" entry at the head of the list, which hands back `null`. */
  inherit?: { label: string; hint?: string };
  /** Offer a field to type a slug the catalogue does not list, for the opened provider. */
  allowCustomSlug: boolean;
  /** Restricts the catalogue (rail, lists, favourites, search). */
  filter?: ModelPickerFilter;
  /** The mission this picker chooses for, `null` when the list is the inventory (a setting of the whole instance). `useBackendCatalog()` already reads for it. */
  target: CatalogTarget | null;
  /** The surface's own settings, rendered under the list (the composer's thinking and context). */
  footer?: ReactNode;
  /** No pick possible; favourites stay usable — they are the account's, not the form's. */
  disabled: boolean;
  /** Focus the search on mount: in a popover, on request in a panel — never on a touch screen, where it would open the soft keyboard. */
  autoFocusSearch: boolean;
  /** Size of the occupant's root (height, width, flex): put it on the outer element. */
  className: string;
  /** Accessible name of the picker. */
  label: string;
  /**
   * Popover only (`null` in a panel): where it opens, how to close it without
   * a pick, and `keepOpenOnPick` — the surface keeps the popover open after a
   * pick (the composer arms a confirmation in its `footer`), so `onChange`
   * does not close it then.
   */
  popover: { align: PopoverAlign; side: PopoverPlacement; close: () => void; keepOpenOnPick: boolean } | null;
};

const ModelPickerContext = createContext<ModelPickerContextValue | null>(null);

export const ModelPickerContextProvider = ModelPickerContext.Provider;

/** Readable by a plugin that takes the `model.picker` slot; `null` outside a picker. */
export function useModelPicker(): ModelPickerContextValue | null {
  return useContext(ModelPickerContext);
}
