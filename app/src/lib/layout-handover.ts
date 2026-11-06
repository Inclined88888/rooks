/**
 * Where a layout row that holds nothing yet takes its first value from.
 *
 * Two kinds of source, read in order, the first one holding something wins:
 *  - a row the same arrangement was stored under before its scope changed,
 *    one to one with the new row: the same view and project hashed with the
 *    local session's id, on a remote machine whose rows used to be
 *    (`previousLayoutOwner`, TIM-0137). It is CONSUMED: copied, then erased,
 *    so nothing reads it twice and a reset of the new row never brings it back;
 *  - a row shared by many scopes (`cockpit`, `chat.columns`, a view's rail
 *    leftover), which seeds every view migrating after this one. It is KEPT.
 *
 * Pure and client-safe: the hook (`useStoredLayout`), the read-ahead of a chat
 * switch (`preloadStoredLayout`) and the server render (`resolveLayoutSeeds`)
 * walk the same chain with `readHandover`. Only the hook writes; the two others
 * merely paint what the hook is about to copy.
 */

export type LayoutSource = {
  scope: string;
  /** Erased once its value is written under the new scope. */
  consumed?: boolean;
};

export type LayoutHandover = readonly LayoutSource[];

/** Every way a caller names its sources: one kept scope (the historical
 *  `legacyScope`), or a chain. */
export type LayoutHandoverInput = string | LayoutHandover | null | undefined;

export function handoverOf(input: LayoutHandoverInput): LayoutHandover {
  if (!input) return [];
  return typeof input === 'string' ? [{ scope: input }] : input;
}

/**
 * The chain of a row: the row it was stored under before its scope changed
 * (consumed), then the shared one it falls back to (kept). Either may be
 * missing.
 */
export function rowHandover(previous: string | null | undefined, shared?: string | null): LayoutHandover {
  const chain: LayoutSource[] = [];
  if (previous) chain.push({ scope: previous, consumed: true });
  if (shared) chain.push({ scope: shared });
  return chain;
}

/** The identity of a chain, for an effect's dependency list: a caller builds a
 *  fresh array at every render, and the read must not start again for it. */
export function handoverKey(input: LayoutHandoverInput): string {
  return handoverOf(input).map(({ scope, consumed }) => `${consumed ? '-' : '='}${scope}`).join('\n');
}

export type HandoverRead = { ok: true; raw: unknown; from: LayoutSource | null } | { ok: false };

/**
 * Walks `chain` with `load` until a source holds something. A source that
 * cannot be read stops the walk: going on to the next one would copy a shared
 * value over the new row, which then holds something, and the row this one
 * could not read would never be handed over.
 */
export async function readHandover(
  chain: LayoutHandover,
  load: (scope: string) => Promise<{ ok: boolean; raw: unknown }>,
): Promise<HandoverRead> {
  for (const source of chain) {
    const out = await load(source.scope);
    if (!out.ok) return { ok: false };
    if (out.raw !== null && out.raw !== undefined) return { ok: true, raw: out.raw, from: source };
  }
  return { ok: true, raw: null, from: null };
}
