/**
 * What the ModelPicker shows, as pure functions of the catalogue, the value,
 * the favourites and the search — so a test pins it without a DOM.
 *
 * Contract and rationale: `docs/MODEL-PICKER.md`.
 */
import {
  accountStateHint,
  backendLabel,
  catalogPending,
  isAccountInstance,
  isNewModel,
  isPickable,
  type BackendCatalog,
  type BackendName,
  type CatalogBackend,
  type CatalogModel,
} from '@/lib/backends';
import { byPower, matchesQuery } from '@/lib/llm-sort';
import { t } from '@/lib/i18n';

/** What a picker holds and hands back: an exact catalogue entry (account instance included) and a model slug. */
export type ModelPick = { backend: BackendName; model: string };

/** Restricts the catalogue: a model is offered only when it returns true. */
export type ModelPickerFilter = (backend: CatalogBackend, model: CatalogModel) => boolean;

/** The left rail's selection: the favourites, or one catalogue entry. */
export type PickerView = { kind: 'favorites' } | { kind: 'provider'; backend: BackendName };

export type PickerRow = {
  key: string;
  backend: BackendName;
  slug: string;
  label: string;
  /** Shown under the name in the favourites and in search results, where two accounts can serve the same model. */
  vendor?: string;
  /** The subscription account serving the row, with `vendor`: a badge beside the name. */
  account?: string;
  contextWindow?: number;
  /** Added to the catalogue less than a week ago (`isNewModel`): the row carries a "new" badge. */
  isNew?: boolean;
  /** The model can be chosen (its account can run). */
  pickable: boolean;
  /** Why it cannot, or what is special about it (a `title`). */
  hint?: string;
  selected: boolean;
  isFavorite: boolean;
  /** A favourite can be toggled on this row: a value the catalogue does not list cannot be starred. */
  starrable: boolean;
  /** The value held while the catalogue loads (`catalogPending`): shown as it is, not offered yet, never greyed as unavailable. */
  pending?: boolean;
};

/** The catalogue entries the rail lists: all of them, or with a filter those that keep at least one model. */
export function providersOf(cat: BackendCatalog, filter?: ModelPickerFilter): CatalogBackend[] {
  if (!filter) return cat.backends;
  return cat.backends.filter((b) => b.models.some((m) => filter(b, m)));
}

function modelsOf(backend: CatalogBackend, filter?: ModelPickerFilter): CatalogModel[] {
  return filter ? backend.models.filter((m) => filter(backend, m)) : backend.models;
}

/** The favourites still offered: account listed, model listed, filter passed. The others are hidden, never dropped. */
export function visibleFavorites(
  cat: BackendCatalog,
  favorites: readonly ModelPick[],
  filter?: ModelPickerFilter,
): { backend: CatalogBackend; model: CatalogModel }[] {
  const out: { backend: CatalogBackend; model: CatalogModel }[] = [];
  for (const fav of favorites) {
    const backend = cat.backends.find((b) => b.id === fav.backend);
    const model = backend?.models.find((m) => m.slug === fav.model);
    if (!backend || !model || (filter && !filter(backend, model))) continue;
    out.push({ backend, model });
  }
  return out;
}

/** Opened first: the value's provider, else the favourites when there are some, else the first provider. */
export function initialView(
  cat: BackendCatalog,
  value: ModelPick | null,
  favorites: readonly ModelPick[],
  filter?: ModelPickerFilter,
): PickerView {
  const providers = providersOf(cat, filter);
  if (value && providers.some((b) => b.id === value.backend)) return { kind: 'provider', backend: value.backend };
  if (visibleFavorites(cat, favorites, filter).length > 0) return { kind: 'favorites' };
  const first = providers[0];
  return first ? { kind: 'provider', backend: first.id } : { kind: 'favorites' };
}

/** A value the catalogue does not list as such: its account is gone, or its model is a slug typed by hand. */
export type OrphanValue = { kind: 'gone' | 'custom'; label: string; hint: string };

/**
 * A stored value the catalogue no longer offers stays shown, disabled,
 * instead of reading as another account.
 * A slug typed by hand on a listed provider is not gone: it stays the value.
 * Nothing is decided before the catalogue has loaded (`catalogPending`).
 * `targeted`: the catalogue was read for one mission (`ModelPickerProps.target`).
 */
export function orphanOf(cat: BackendCatalog, value: ModelPick | null, targeted = false): OrphanValue | null {
  if (!value || catalogPending(cat)) return null;
  const backend = cat.backends.find((b) => b.id === value.backend);
  if (!backend) {
    return {
      kind: 'gone',
      label: `${value.model} · ${backendLabel(cat, value.backend)}`,
      hint: isAccountInstance(value.backend)
        ? t('llm.account.unavailableHint')
        // A catalogue read for a mission leaves out what is not granted to it: the provider is not gone.
        : t(targeted ? 'modelPicker.notGrantedHint' : 'modelPicker.goneHint'),
    };
  }
  if (backend.models.some((m) => m.slug === value.model)) return null;
  return { kind: 'custom', label: value.model, hint: t('modelPicker.notInCatalog') };
}

function rowOf(
  backend: CatalogBackend,
  model: CatalogModel,
  value: ModelPick | null,
  isFavorite: (pick: ModelPick) => boolean,
  withVendor: boolean,
): PickerRow {
  const pickable = isPickable(backend);
  const hint = pickable ? undefined : accountStateHint(backend) ?? undefined;
  return {
    key: `${backend.id}\u0000${model.slug}`,
    backend: backend.id,
    slug: model.slug,
    label: model.presetLabel ?? model.label,
    ...(withVendor ? { vendor: backend.vendor ?? backend.label } : {}),
    ...(withVendor && backend.account ? { account: backend.account.name } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(isNewModel(model) ? { isNew: true } : {}),
    pickable,
    ...(hint ? { hint } : {}),
    selected: !!value && value.backend === backend.id && value.model === model.slug,
    isFavorite: isFavorite({ backend: backend.id, model: model.slug }),
    starrable: true,
  };
}

/**
 * The list on the right. A non-empty search looks through the whole
 * (filtered) catalogue, provider by provider in the rail's order; otherwise
 * the opened view. A slug typed by hand on the opened provider leads its list,
 * selected, so the value never disappears from view.
 */
export function rowsFor(args: {
  catalog: BackendCatalog;
  view: PickerView;
  query: string;
  value: ModelPick | null;
  favorites: readonly ModelPick[];
  filter?: ModelPickerFilter;
}): PickerRow[] {
  const { catalog, view, value, favorites, filter } = args;
  const query = args.query.trim().toLowerCase();
  if (catalogPending(catalog)) return value && !query ? [pendingRow(value)] : [];
  const isFavorite = (pick: ModelPick) => favorites.some((f) => f.backend === pick.backend && f.model === pick.model);
  if (query) {
    return providersOf(catalog, filter).flatMap((backend) =>
      byPower(modelsOf(backend, filter).filter((m) => matchesQuery(backend, m, query)))
        .map((model) => rowOf(backend, model, value, isFavorite, true)));
  }
  if (view.kind === 'favorites') {
    return visibleFavorites(catalog, favorites, filter)
      .map(({ backend, model }) => rowOf(backend, model, value, isFavorite, true));
  }
  const backend = providersOf(catalog, filter).find((b) => b.id === view.backend);
  if (!backend) return [];
  const rows = byPower(modelsOf(backend, filter)).map((model) => rowOf(backend, model, value, isFavorite, false));
  const orphan = orphanOf(catalog, value);
  if (orphan?.kind === 'custom' && value?.backend === backend.id) {
    rows.unshift({
      key: `${backend.id}\u0000${value.model}\u0000custom`,
      backend: backend.id,
      slug: value.model,
      label: value.model,
      pickable: isPickable(backend),
      hint: orphan.hint,
      selected: true,
      isFavorite: false,
      starrable: false,
    });
  }
  return rows;
}

/** The value as it is held, while the catalogue loads: nothing is known yet to name it otherwise. */
function pendingRow(value: ModelPick): PickerRow {
  const base = value.backend.includes('@') ? value.backend.slice(0, value.backend.indexOf('@')) : value.backend;
  return {
    key: `${value.backend}\u0000${value.model}\u0000pending`,
    backend: value.backend,
    slug: value.model,
    label: value.model || base,
    ...(value.model && base ? { vendor: base } : {}),
    pickable: false,
    hint: t('modelPicker.loading'),
    selected: true,
    isFavorite: false,
    starrable: false,
    pending: true,
  };
}

/** The trigger chip's words: the model's short name, or the slug as typed (the backend while no slug is known yet). */
export function pickLabel(cat: BackendCatalog, value: ModelPick): string {
  const model = cat.backends.find((b) => b.id === value.backend)?.models.find((m) => m.slug === value.model);
  return model ? model.presetLabel ?? model.label : value.model || value.backend;
}

/**
 * Whether a host lets a pick reach the form. The `model.picker` slot can be
 * taken by a plugin, so the rules the product's picker follows by
 * construction are enforced here, whoever paints the list: nothing while
 * `disabled`; `null` only with an inherit entry; never an account that cannot
 * run, nor a catalogue entry the surface's `filter` rejects; a slug the
 * catalogue does not list only where typing one is offered — or when it is
 * the value already held, which the product shows at the head of its list.
 */
export function acceptsPick(
  cat: BackendCatalog,
  pick: ModelPick | null,
  opts: {
    value: ModelPick | null;
    inherit: boolean;
    allowCustomSlug: boolean;
    disabled: boolean;
    filter?: ModelPickerFilter;
  },
): boolean {
  if (opts.disabled) return false;
  if (pick === null) return opts.inherit;
  if (typeof pick.backend !== 'string' || typeof pick.model !== 'string' || !pick.model.trim()) return false;
  const backend = cat.backends.find((b) => b.id === pick.backend);
  if (!backend || !isPickable(backend)) return false;
  const model = backend.models.find((m) => m.slug === pick.model);
  if (model) return !opts.filter || opts.filter(backend, model);
  if (opts.value?.backend === pick.backend && opts.value.model === pick.model) return true;
  return opts.allowCustomSlug && providersOf(cat, opts.filter).includes(backend);
}
