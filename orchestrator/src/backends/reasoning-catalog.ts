/**
 * What models.dev says about a model's thinking controls, read from the snapshot
 * committed in `reasoning-catalog.snapshot.ts` (`scripts/gen-reasoning-catalog.mjs`).
 *
 * A custom provider's endpoint lists model ids and nothing else, so this is the
 * only local source for "does this model think, and how is that set". It answers
 * for the MODEL, not for the endpoint: a gateway may ignore a control the model
 * supports (measured on B.AI: Qwen accepts an effort and does nothing with it).
 *
 * Lookup order for an id served by a host:
 *   1. the host's own entry, when the host is listed (matched by API hostname);
 *   2. the entry of the LAB that made the model (Anthropic, OpenAI, Alibaba…),
 *      directly by id, else through the `canonical_model_id` that hosts record;
 *   3. nothing.
 * An id that leads to two entries with different controls answers nothing: a
 * guess here becomes a slider that drives nothing.
 *
 * Never throws. The snapshot is parsed and validated on first use, not at import
 * (the daemon's helper runners import this module's neighbours), and an invalid
 * snapshot disables the lookup with a single warning.
 */

import { z } from 'zod';
import { REASONING_SNAPSHOT_JSON } from './reasoning-catalog.snapshot.js';

/** Entry codes besides an index in the option table (see the generator). */
const NO_REASONING = -1;
const UNKNOWN_OPTIONS = -2;

const optionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('toggle') }),
  z.strictObject({ type: z.literal('effort'), values: z.array(z.string().min(1).max(40)).max(20) }),
  z.strictObject({ type: z.literal('budget_tokens'), min: z.number().int().optional(), max: z.number().int().optional() }),
]);

const snapshotSchema = z.strictObject({
  source: z.string(),
  generatedAt: z.string(),
  license: z.string().min(1),
  options: z.array(z.array(optionSchema).max(8)),
  providers: z.record(z.string(), z.strictObject({
    api: z.string().optional(),
    models: z.record(z.string(), z.union([
      z.tuple([z.number().int().min(UNKNOWN_OPTIONS)]),
      z.tuple([z.number().int().min(UNKNOWN_OPTIONS), z.string().min(3)]),
    ])),
  })),
});

export type CatalogOption = z.infer<typeof optionSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;

/** What the catalogue knows of one model. `options` is null when the model does
 *  not reason at all; an empty array means it reasons with no caller control. */
export type CatalogReasoning = {
  /** `provider/model` of the entry that answered, for diagnostics. */
  entry: string;
  options: CatalogOption[] | null;
};

/**
 * The comparison key of a model id, the same on both sides of a match:
 *   - the vendor prefix goes (`Qwen/Qwen3.8-Max`, `accounts/fireworks/models/x`);
 *   - case goes;
 *   - dots, underscores and spaces become dashes, so `claude-opus-5.5` (B.AI)
 *     meets `claude-opus-5-5` (Anthropic) and `qwen3.8-max` meets itself.
 */
export function normalizeModelId(id: string): string {
  const lower = id.trim().toLowerCase();
  const bare = lower.slice(lower.lastIndexOf('/') + 1);
  return bare.replace(/[._\s]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
}

type Ref = { provider: string; model: string; code: number; canonical: string | null };

type Index = {
  snapshot: Snapshot;
  /** Providers that are also a lab: the prefix of some `canonical_model_id`. */
  labs: Set<string>;
  /** normalized id → lab entries carrying it. */
  labEntries: Map<string, Ref[]>;
  /** normalized id → `canonical_model_id`s that hosts record for it. */
  canonicals: Map<string, Set<string>>;
  /** provider → normalized id → its entries. */
  byProvider: Map<string, Map<string, Ref[]>>;
  /** API hostname → provider, only where a single provider claims it. */
  hosts: Map<string, string>;
};

let index: Index | null | undefined;
/** Answers already computed: the catalogue view is re-derived on every read,
 *  which sits on the dispatch path, for every model of every custom provider. */
const memo = new Map<string, CatalogReasoning | null>();
const MEMO_LIMIT = 5000;

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function build(raw: string): Index | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = snapshotSchema.safeParse(parsed);
  if (!result.success) return null;
  const snapshot = result.data;
  const labs = new Set<string>();
  for (const provider of Object.values(snapshot.providers)) {
    for (const entry of Object.values(provider.models)) {
      const canonical = entry[1];
      if (canonical) labs.add(canonical.slice(0, canonical.indexOf('/')));
    }
  }
  for (const lab of labs) if (!snapshot.providers[lab]) labs.delete(lab);

  const labEntries = new Map<string, Ref[]>();
  const canonicals = new Map<string, Set<string>>();
  const byProvider = new Map<string, Map<string, Ref[]>>();
  const hostClaims = new Map<string, string[]>();
  for (const [provider, data] of Object.entries(snapshot.providers)) {
    if (data.api) push(hostClaims, data.api, provider);
    const own = new Map<string, Ref[]>();
    byProvider.set(provider, own);
    for (const [model, entry] of Object.entries(data.models)) {
      const key = normalizeModelId(model);
      const ref: Ref = { provider, model, code: entry[0], canonical: entry[1] ?? null };
      push(own, key, ref);
      // A lab also relays other labs' models (its entry then names their
      // canonical id): only its own models count as lab entries.
      const ownModel = !ref.canonical || ref.canonical.startsWith(`${provider}/`); // portability: a model id prefix, not a path
      if (labs.has(provider) && ownModel && ref.code !== UNKNOWN_OPTIONS) push(labEntries, key, ref);
      if (ref.canonical) {
        let set = canonicals.get(key);
        if (!set) canonicals.set(key, set = new Set());
        set.add(ref.canonical);
      }
    }
  }
  const hosts = new Map<string, string>();
  for (const [host, providers] of hostClaims) if (providers.length === 1) hosts.set(host, providers[0]!);
  return { snapshot, labs, labEntries, canonicals, byProvider, hosts };
}

function loaded(): Index | null {
  if (index === undefined) {
    index = build(REASONING_SNAPSHOT_JSON);
    if (!index) console.warn('[reasoning-catalog] the embedded models.dev snapshot is invalid; catalogue lookups are disabled');
  }
  return index;
}

/** Test seam: replace the snapshot (null restores the embedded one). */
export function useReasoningSnapshotForTests(raw: string | null): void {
  index = raw === null ? undefined : build(raw);
  memo.clear();
}

function answer(idx: Index, ref: Ref): CatalogReasoning {
  return {
    entry: `${ref.provider}/${ref.model}`,
    options: ref.code === NO_REASONING ? null : idx.snapshot.options[ref.code] ?? null,
  };
}

/** The single answer a list of entries gives, or null when they disagree. */
function agree(idx: Index, refs: readonly Ref[]): CatalogReasoning | null {
  const known = refs.filter((ref) => ref.code !== UNKNOWN_OPTIONS);
  if (known.length === 0) return null;
  const codes = new Set(known.map((ref) => ref.code));
  return codes.size === 1 ? answer(idx, known[0]!) : null;
}

/** The lab entry a `canonical_model_id` designates. */
function labEntryFor(idx: Index, canonical: string): Ref[] {
  const slash = canonical.indexOf('/');
  const lab = canonical.slice(0, slash);
  if (!idx.labs.has(lab)) return [];
  const model = canonical.slice(slash + 1);
  const exact = idx.snapshot.providers[lab]?.models[model];
  if (exact && exact[0] !== UNKNOWN_OPTIONS) return [{ provider: lab, model, code: exact[0], canonical }];
  return (idx.labEntries.get(normalizeModelId(model)) ?? []).filter((ref) => ref.provider === lab);
}

function fromLab(idx: Index, key: string): CatalogReasoning | null {
  const canonicals = [...(idx.canonicals.get(key) ?? [])];
  // A lab listing the id itself beats any deduction from what hosts call it.
  const direct = idx.labEntries.get(key);
  if (direct?.length) {
    const single = agree(idx, direct);
    if (single) return single;
    // Two "labs" list it (a small host with a model of its own is a lab too):
    // the one the hosts name as the model's maker settles it.
    const makers = new Set(canonicals.map((canonical) => canonical.slice(0, canonical.indexOf('/'))));
    return agree(idx, direct.filter((ref) => makers.has(ref.provider)));
  }
  return agree(idx, canonicals.flatMap((canonical) => labEntryFor(idx, canonical)));
}

/** Hostname of a base URL, lowercased, or null when it is not a URL. */
function hostnameOf(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * What the catalogue says about `modelId` as served from `baseUrl` (optional).
 * Null when it does not know, or when its entries disagree.
 */
export function lookupCatalogReasoning(modelId: string, baseUrl?: string | null): CatalogReasoning | null {
  const idx = loaded();
  if (!idx) return null;
  const host = hostnameOf(baseUrl);
  const memoKey = `${host ?? ''}\n${modelId}`;
  const known = memo.get(memoKey);
  if (known !== undefined) return known;
  const found = lookup(idx, modelId, host);
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(memoKey, found);
  return found;
}

function lookup(idx: Index, modelId: string, host: string | null): CatalogReasoning | null {
  const key = normalizeModelId(modelId);
  if (!key) return null;
  const hostProvider = host ? idx.hosts.get(host) : undefined;
  if (hostProvider) {
    const refs = idx.byProvider.get(hostProvider)?.get(key) ?? [];
    const own = agree(idx, refs);
    if (own) return own;
    // Listed, but silent on reasoning: the lab model it relays still answers.
    const relayed = refs.flatMap((ref) => (ref.canonical ? labEntryFor(idx, ref.canonical) : []));
    const viaCanonical = agree(idx, relayed);
    if (viaCanonical) return viaCanonical;
  }
  return fromLab(idx, key);
}

/** Licence and provenance of the embedded data, for the about/diagnostics views. */
export function reasoningCatalogInfo(): { source: string; generatedAt: string; license: string } | null {
  const idx = loaded();
  return idx ? { source: idx.snapshot.source, generatedAt: idx.snapshot.generatedAt, license: idx.snapshot.license } : null;
}
