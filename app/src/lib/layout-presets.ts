/**
 * Named arrangements of a view, stored under one scope.
 *
 * A view does not keep its arrangement in a single row: `widget-host` writes
 * `<key>.widgets`, the chat's rails `<key>.columns`, the nav `<key>.nav`, and
 * any plugin may open its own (`plugins-client/workflows` already did). A
 * preset is therefore a *photograph of the family*, not of one value — see
 * `docs/LAYOUT-PRESETS.md`.
 *
 * Suffixes are stored relative to the view's key (`widgets`, `columns`…) and
 * never as full scopes: a preset must survive being read next to the key it
 * belongs to, and repeating a 43-character hash on every entry would cost more
 * than the arrangement itself.
 *
 * Every function here is pure and takes the stored JSON as an opaque value:
 * a row written by an older build, or by nothing at all, must degrade to "no
 * preset" rather than throw somewhere inside a dropdown.
 */

/** Suffix of the row holding the presets themselves. Excluded from every
 *  capture: a preset that photographed this row would carry a copy of all the
 *  ones saved before it. */
export const PRESETS_SUFFIX = 'presets';

/** Suffix of the row holding the presets shared by every project of a view
 *  (`lib/workspace-scope.ts`). Excluded from every capture for the same reason
 *  as the one above, and for one more: on a view without a project it sits
 *  under that view's OWN prefix, so a capture would photograph the whole
 *  list into each preset it saves. */
export const SHARED_PRESETS_SUFFIX = 'shared-presets';

/** Suffix the rail wrote under each view key before its pinned state became
 *  the account's (`sharedNavScope`). Read once, as a migration source, when
 *  the shared row is still empty: not part of a view's arrangement, so never
 *  captured. */
export const LEFTOVER_NAV_SUFFIX = 'nav';

/** Dispatched after a recall has written the rows out of band, so that the
 *  consumers already mounted re-read instead of repainting the arrangement
 *  they were showing. Mirrors `APPEARANCE_EVENT` (`rooks:native-theme`). */
export const LAYOUT_RECALLED_EVENT = 'rooks:layout-recalled';

/** The whole family of a view lives in one row, itself capped by the daemon.
 *  Bounded here so the limit is a sentence in the menu rather than a 400 at the
 *  moment the user hits save. */
export const MAX_PRESETS = 12;
export const MAX_NAME_LENGTH = 40;

/**
 * The daemon's own cap on a layout row, mirrored.
 *
 * Source of truth: `LAYOUT_MAX_BYTES` in
 * `orchestrator/src/plugins-bundled/settings/routes.ts`. Copied rather than
 * imported because the two packages are independent — the same arrangement as
 * `brand.ts` and its front copy (CLAUDE.md). Both sides are pinned by a test
 * at the exact boundary, so moving one without the other turns red.
 *
 * A count that is not a rule of thumb: the daemon measures
 * `JSON.stringify(body.layout)`, so the client must measure the presets row
 * itself and never the `{ layout }` envelope — eleven bytes of difference
 * would make the two verdicts disagree exactly at the limit.
 */
export const MAX_PRESETS_BYTES = 64 * 1024;

export type LayoutPreset = {
  id: string;
  name: string;
  createdAt: number;
  /** Suffix → stored value, both opaque. */
  scopes: Readonly<Record<string, unknown>>;
};

type Stored = { v: 1; presets: LayoutPreset[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPreset(value: unknown): LayoutPreset | null {
  if (!isRecord(value)) return null;
  const { id, name, createdAt, scopes } = value;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof name !== 'string' || name.trim() === '') return null;
  if (!isRecord(scopes)) return null;
  return {
    id,
    name,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
    scopes,
  };
}

/**
 * The presets of a view, in the order they were saved.
 *
 * Entries that no longer parse are dropped one by one rather than voiding the
 * row: one corrupted preset must not take the eleven valid ones with it.
 * Duplicate ids keep the first — a later write would otherwise be ambiguous.
 */
export function readPresets(raw: unknown): LayoutPreset[] {
  const list = isRecord(raw) && Array.isArray(raw.presets) ? raw.presets : [];
  const out: LayoutPreset[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const preset = readPreset(entry);
    if (!preset || seen.has(preset.id)) continue;
    seen.add(preset.id);
    out.push(preset);
  }
  return out;
}

export function writePresets(presets: readonly LayoutPreset[]): Stored {
  return { v: 1, presets: [...presets] };
}

/** Size of the row a write would send, in UTF-8 bytes — the unit the daemon
 *  counts in. `TextEncoder` is what a browser has; `Buffer` is not. */
export function presetsBytes(presets: readonly LayoutPreset[]): number {
  return new TextEncoder().encode(JSON.stringify(writePresets(presets))).length;
}

/** Whether the daemon would take that row. Equality passes: the daemon refuses
 *  what is strictly over the cap. */
export function fitsPresets(presets: readonly LayoutPreset[]): boolean {
  return presetsBytes(presets) <= MAX_PRESETS_BYTES;
}

/** Trimmed and capped. An empty result means "no name given" and is the one
 *  thing a caller must refuse, since the menu would show a blank row. */
export function normaliseName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

/** `crypto.randomUUID` is not offered on a plain-HTTP origin outside
 *  localhost, and a preset must still be savable there. */
export function newPresetId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export type PresetError =
  | 'empty-name'
  | 'duplicate-name'
  | 'too-many'
  | 'unknown'
  /** The row the daemon would refuse: a view whose arrangement is itself heavy
   *  reaches the cap well before the twelfth preset. */
  | 'too-large'
  /** The daemon did not take the row. Distinct from every error above: nothing
   *  is wrong with what the user asked for, it simply is not stored. */
  | 'write-failed';

export type PresetResult =
  | { ok: true; presets: LayoutPreset[]; preset: LayoutPreset }
  | { ok: false; error: PresetError };

/** Names are compared case- and accent-insensitively: two presets a user reads
 *  as the same name are the same name, and letting both exist makes the menu
 *  unusable without telling anyone why. */
export function sameName(a: string, b: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return fold(a) === fold(b);
}

export function addPreset(
  presets: readonly LayoutPreset[],
  rawName: string,
  scopes: Readonly<Record<string, unknown>>,
  now: number = Date.now(),
): PresetResult {
  const name = normaliseName(rawName);
  if (name === '') return { ok: false, error: 'empty-name' };
  if (presets.some((p) => sameName(p.name, name))) return { ok: false, error: 'duplicate-name' };
  if (presets.length >= MAX_PRESETS) return { ok: false, error: 'too-many' };
  const preset: LayoutPreset = { id: newPresetId(), name, createdAt: now, scopes };
  return { ok: true, presets: [...presets, preset], preset };
}

export function renamePreset(
  presets: readonly LayoutPreset[],
  id: string,
  rawName: string,
): PresetResult {
  const name = normaliseName(rawName);
  if (name === '') return { ok: false, error: 'empty-name' };
  const index = presets.findIndex((p) => p.id === id);
  const current = presets[index];
  if (!current) return { ok: false, error: 'unknown' };
  // A preset compared against itself is not a duplicate: fixing the case of
  // one's own name must stay possible.
  if (presets.some((p) => p.id !== id && sameName(p.name, name))) {
    return { ok: false, error: 'duplicate-name' };
  }
  const preset: LayoutPreset = { ...current, name };
  const out = [...presets];
  out[index] = preset;
  return { ok: true, presets: out, preset };
}

/** Overwrites a preset's arrangement, keeping its name, its id and its
 *  creation date: the user is correcting one entry of the menu, not replacing
 *  it with a new one that would jump to the end of the list. */
export function replacePreset(
  presets: readonly LayoutPreset[],
  id: string,
  scopes: Readonly<Record<string, unknown>>,
): PresetResult {
  const index = presets.findIndex((p) => p.id === id);
  const current = presets[index];
  if (!current) return { ok: false, error: 'unknown' };
  const preset: LayoutPreset = { ...current, scopes };
  const out = [...presets];
  out[index] = preset;
  return { ok: true, presets: out, preset };
}

/**
 * The shared list, plus what an older per-project list still holds alone.
 *
 * Migration only (`components/layout-presets-menu.tsx`): until 11/09/2026 a
 * list was stored per `(compte, vue, projet)`, so the presets a user had
 * already saved live under keys nothing reads any more. They are folded into
 * the shared row the first time it is read empty.
 *
 * Truncates rather than refusing. Two lists that each fit may not fit
 * together, and a migration is a gesture nobody asked for: an error banner
 * over it would be unexplainable, while dropping the tail keeps the menu
 * usable and loses only what the daemon would have refused anyway. Both caps
 * are applied, the count first because it is the cheaper of the two.
 *
 * Entries whose id OR whose name is already in the shared list are skipped:
 * the menu forbids two presets a user reads as the same name, and a migration
 * must not be the one thing that creates one.
 */
export function mergePresets(
  shared: readonly LayoutPreset[],
  legacy: readonly LayoutPreset[],
): LayoutPreset[] {
  const out = [...shared];
  for (const preset of legacy) {
    if (out.length >= MAX_PRESETS) break;
    if (out.some((p) => p.id === preset.id || sameName(p.name, preset.name))) continue;
    out.push(preset);
  }
  while (out.length > 0 && !fitsPresets(out)) out.pop();
  return out;
}

/**
 * The row of presets a remote machine's list still sits in from before its
 * scopes followed the acting account (TIM-0137), when it has to be folded in
 * now: the list is read, the row is another one, and it was not folded yet in
 * this document. Unlike `<key>.presets`, folded whatever the current list
 * holds — a preset may have been saved on that machine since the update —
 * which `mergePresets` makes safe to repeat. `null`: nothing to fold.
 */
export function previousPresetsSource(
  sharedKey: string | null,
  previousSharedKey: string | null | undefined,
  ready: boolean,
  folded: ReadonlySet<string>,
): string | null {
  if (!sharedKey || !ready || !previousSharedKey || previousSharedKey === sharedKey) return null;
  return folded.has(previousSharedKey) ? null : previousSharedKey;
}

export function removePreset(presets: readonly LayoutPreset[], id: string): LayoutPreset[] {
  return presets.filter((p) => p.id !== id);
}

/**
 * What a row becomes when it enters a preset, declared by the suffix of the
 * row it applies to. The owner of a row is the only one that knows which part
 * of it is a day's state: the island workspace drops a chat's conversation and
 * a terminal's shell from `islands` (`lib/island-presets.ts`). A suffix
 * without a hook is photographed as is — which is every row a plugin opens
 * without saying anything.
 */
export type CaptureHooks = Readonly<Record<string, (layout: unknown) => unknown>>;

function hooked(hooks: CaptureHooks, suffix: string, layout: unknown): unknown {
  const hook = Object.hasOwn(hooks, suffix) ? hooks[suffix] : undefined;
  return hook ? hook(layout) : layout;
}

/**
 * The arrangement of a view, as suffixes, from the rows the daemon returned.
 *
 * `prefix` is `<key>.`; anything not under it never reached this function.
 * The presets row is dropped here rather than at the call site so that no
 * caller can forget it.
 */
export function captureScopes(
  prefix: string,
  rows: readonly { scope: string; layout: unknown }[],
  hooks: CaptureHooks = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row.scope.startsWith(prefix)) continue;
    const suffix = row.scope.slice(prefix.length);
    if (suffix === '' || suffix === PRESETS_SUFFIX || suffix === SHARED_PRESETS_SUFFIX || suffix === LEFTOVER_NAV_SUFFIX) continue;
    out[suffix] = hooked(hooks, suffix, row.layout);
  }
  return out;
}

/**
 * A stored preset, passed through the same hooks as a capture.
 *
 * At recall, not only at capture: a preset saved before a hook existed, or by
 * the daemon for an agent (`islands_preset_save`), still carries what the hook
 * drops. Running it again on a preset it already cleaned changes nothing.
 */
export function hookedPreset(preset: LayoutPreset, hooks: CaptureHooks): LayoutPreset {
  const scopes: Record<string, unknown> = {};
  for (const [suffix, layout] of Object.entries(preset.scopes)) scopes[suffix] = hooked(hooks, suffix, layout);
  return { ...preset, scopes };
}

/**
 * What a recall has to write: the preset's rows, plus an explicit erasure of
 * the rows the view holds today and the preset does not.
 *
 * Without that second half, recalling a preset saved before a rail existed
 * would leave that rail exactly as the previous arrangement had it — the
 * preset would be additive, and the same click would give a different screen
 * depending on what was on it beforehand. `null` is what `useStoredLayout`
 * already reads as "nothing stored", so it puts the consumer back on its
 * defaults instead of inventing a shape it would have to understand.
 */
export function recallWrites(
  preset: LayoutPreset,
  current: Readonly<Record<string, unknown>>,
): { suffix: string; layout: unknown }[] {
  const writes = Object.entries(preset.scopes).map(([suffix, layout]) => ({ suffix, layout }));
  for (const suffix of Object.keys(current)) {
    if (!(suffix in preset.scopes)) writes.push({ suffix, layout: null });
  }
  return writes.sort((a, b) => a.suffix.localeCompare(b.suffix));
}
