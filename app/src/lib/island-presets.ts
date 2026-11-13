/**
 * What an island tree becomes once it stops being the state of a day and
 * becomes an arrangement to replay: a preset of the view, or a named
 * arrangement (`docs/ISLAND-WORKSPACE.md` §4, step 13).
 *
 * Each content type declares which of its params are a day's state
 * (`volatileParams`: a chat's conversation, a terminal's shell). The view's
 * own row keeps them — reloading the page must reopen the same conversation —
 * but a preset drops them: recalling an arrangement brings the agents back,
 * never the conversations (the decision of the multichat templates).
 *
 * Pure: the types are handed in, so the rule is tested without a mounted
 * workspace and applied the same way at capture and at recall.
 */

import {
  HOST_ROUTE,
  normalizeIslandTree,
  readIslandTree,
  type IslandLeaf,
  type IslandParams,
  type IslandTree,
} from './island-tree';

/** Suffix of the view's row: `<workspaceKey>.islands`, 43 + 8 characters (§4). */
export const ISLANDS_SUFFIX = 'islands';

/**
 * The param a type reads as "open a new one" (a new shell, a new
 * conversation). Both product types that hold a day's state use it, and it is
 * what a terminal stripped of its session still accepts: without it, the tab
 * would come back as "content unavailable".
 */
export const FRESH_PARAM = 'fresh';

/** What the capture needs to know of a registered content type. */
export type PresetContentType = {
  volatileParams?: readonly string[];
  parseParams: (raw: unknown) => IslandParams | null;
};

/**
 * A tab's params as a preset stores them, or `null` when the tab cannot be
 * replayed at all and is left out.
 *
 * Without its volatile params the type may refuse what remains — a terminal
 * needs either a session or `fresh`. It is then offered `fresh: true`, the
 * one way to say "a new one of these" that does not name a day's state.
 * Refused again, the tab is dropped: kept, it would only come back as a dead
 * placeholder on every view the preset is applied to.
 */
export function presetParams(params: IslandParams, type: PresetContentType): IslandParams | null {
  const volatile = type.volatileParams ?? [];
  if (!volatile.some((name) => name in params)) return params;
  const kept: IslandParams = {};
  for (const [name, value] of Object.entries(params)) {
    if (!volatile.includes(name)) kept[name] = value;
  }
  if (type.parseParams(kept) !== null) return kept;
  const fresh = { ...kept, [FRESH_PARAM]: true };
  return type.parseParams(fresh) !== null ? fresh : null;
}

function presetLeaf(leaf: IslandLeaf, types: ReadonlyMap<string, PresetContentType>): IslandLeaf {
  const tabs = leaf.tabs.flatMap((tab) => {
    // What the page kept in its tab is a conversation (the chat's page panel,
    // TIM-0140): the day's state, like a chat island's mission.
    if (tab.content.type === HOST_ROUTE) return [Object.keys(tab.content.params).length ? { ...tab, content: { ...tab.content, params: {} } } : tab];
    const type = types.get(tab.content.type);
    // A type no plugin registers today is kept as is: its plugin may come
    // back, and nothing here knows which of its params are volatile.
    if (!type) return [tab];
    const params = presetParams(tab.content.params, type);
    return params ? [{ ...tab, content: { ...tab.content, params } }] : [];
  });
  return { ...leaf, tabs };
}

/**
 * The tree of a view, without its day's state. Takes and returns the stored
 * value: it is the capture hook of the `islands` suffix
 * (`layout-presets.ts`), which only ever sees opaque rows.
 *
 * An absent row stays absent — the default tree is never stored. A leaf whose
 * every tab was dropped disappears with them (`normalizeIslandTree`).
 */
export function presetIslandTree(raw: unknown, types: ReadonlyMap<string, PresetContentType>): unknown {
  if (raw === null || raw === undefined) return raw;
  const tree = readIslandTree(raw);
  const walk = (node: IslandTree['root']): IslandTree['root'] => (node.kind === 'leaf'
    ? presetLeaf(node, types)
    : { ...node, children: node.children.map(walk) });
  return normalizeIslandTree({
    ...tree,
    root: walk(tree.root),
    ...(tree.floats ? { floats: tree.floats.map((float) => ({ ...float, leaf: presetLeaf(float.leaf, types) })) } : {}),
  });
}
