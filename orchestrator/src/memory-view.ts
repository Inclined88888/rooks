/**
 * PURE read/mutation functions of the memory for the UI (dashboard +
 * validation inbox of the promotions). No I/O here (testable like
 * parseFacts/parseReviewVerdict): the callers (index.ts) provide the
 * content of the files and persist the result.
 *
 * Formats consumed:
 *  - proposals.md: blocks written by memory-promote.ts —
 *      <!-- proposal hash:<12hex> kind:<k> count:<n> agent:<name> ts:<iso> [status:<s> ts2:<iso>] -->
 *      - [<kind> ×<n>] <text>
 *        → suggested target: `<file>`   (blocks written before #628 carry the French label)
 *      <!-- /proposal hash:<hash> -->
 *    Pending = no `status:` token in the opening marker.
 *  - learnings.jsonl: 1 JSON LearningEntry per line (memory-capture.ts).
 */

export type FactKind = 'decision' | 'pitfall' | 'preference';
export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

export type Proposal = {
  hash: string;
  kind: FactKind;
  count: number;
  agent: string;
  ts: string;
  text: string;
  target: string;
  status: ProposalStatus;
  tsAction?: string;
};

export type GroupedFact = {
  hash: string;
  kind: FactKind;
  text: string;
  count: number;
  lastTs: string;
};

const KINDS = new Set<FactKind>(['decision', 'pitfall', 'preference']);

/** Parses the `key:value` tokens of an opening marker (values without spaces). */
function parseAttrs(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of inner.trim().split(/\s+/)) {
    const i = tok.indexOf(':');
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}

/** All the proposal blocks of a proposals.md. Malformed blocks (kind/text
 *  missing) silently ignored. */
export function parseProposals(content: string | null): Proposal[] {
  if (!content) return [];
  const out: Proposal[] = [];
  // opening marker only (the closing one is `<!-- /proposal …` → excluded by `proposal\s`)
  const re = /<!--\s*proposal\s+([^>]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const attrs = parseAttrs(m[1]!);
    const kind = attrs.kind as FactKind;
    if (!attrs.hash || !KINDS.has(kind)) continue;
    // body = from the end of the opening marker to the closing marker of this hash
    const bodyStart = m.index + m[0].length;
    const closeRe = new RegExp(`<!--\\s*/proposal\\s+hash:${attrs.hash}\\b[^>]*?-->`);
    const closeM = closeRe.exec(content.slice(bodyStart));
    const body = closeM ? content.slice(bodyStart, bodyStart + closeM.index) : content.slice(bodyStart);
    const textM = /^\s*-\s*(?:\[[^\]]*\]\s*)?(.+?)\s*$/m.exec(body);
    const text = textM ? textM[1]!.trim() : '';
    if (!text) continue;
    // English since #628; the French form stays readable in proposals.md
    // files written before.
    // french-ok: the French label of proposals.md files written before #628
    const targetM = /(?:suggested target|cible sugg[eé]r[eé]e)\s*:\s*`?([^`\n]+?)`?\s*$/m.exec(body);
    const status: ProposalStatus =
      attrs.status === 'accepted' || attrs.status === 'rejected' ? attrs.status : 'pending';
    out.push({
      hash: attrs.hash,
      kind,
      count: Number.isFinite(Number(attrs.count)) ? Number(attrs.count) : 1,
      agent: attrs.agent ?? '',
      ts: attrs.ts ?? '',
      text,
      target: targetM ? targetM[1]!.trim() : '',
      status,
      tsAction: attrs.ts2,
    });
  }
  return out;
}

/**
 * Sets the status of a proposal block (accept/reject) by editing ITS opening
 * marker (`status:` / `ts2:` tokens added or replaced). `changed:false`
 * if the block already carries that status → idempotent guard: the caller must
 * append the target (instructions/decisions) ONLY if `changed`.
 */
export function setProposalStatus(
  content: string,
  hash: string,
  status: 'accepted' | 'rejected',
  ts: string,
): { content: string; changed: boolean } {
  const re = new RegExp(`(<!--\\s*proposal\\s+)([^>]*?)(\\s*-->)`, 'g');
  let changed = false;
  const next = content.replace(re, (full, open: string, attrs: string, close: string) => {
    const a = parseAttrs(attrs);
    if (a.hash !== hash) return full;
    if (a.status === status) return full; // already at that status → no-op
    changed = true;
    // removes a possible old status/ts2, then adds the new ones
    const cleaned = attrs
      .replace(/\s*status:\S+/g, '')
      .replace(/\s*ts2:\S+/g, '')
      .trimEnd();
    return `${open}${cleaned} status:${status} ts2:${ts}${close}`;
  });
  return { content: next, changed };
}

/** Groups learnings.jsonl by hash: count = nb of occurrences, text/kind =
 *  most recent entry (parity with recurrentFacts of memory-promote.ts).
 *  Sort by count desc then lastTs desc. */
export function groupLearnings(jsonl: string | null): GroupedFact[] {
  if (!jsonl) return [];
  const byHash = new Map<string, GroupedFact>();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let j: { hash?: string; kind?: FactKind; text?: string; ts?: string };
    try { j = JSON.parse(line); } catch { continue; }
    if (!j.hash || !j.text || !KINDS.has(j.kind as FactKind)) continue;
    const cur = byHash.get(j.hash);
    const ts = j.ts ?? '';
    if (!cur) {
      byHash.set(j.hash, { hash: j.hash, kind: j.kind as FactKind, text: j.text, count: 1, lastTs: ts });
    } else {
      cur.count++;
      if (ts >= cur.lastTs) { cur.lastTs = ts; cur.text = j.text; cur.kind = j.kind as FactKind; }
    }
  }
  return [...byHash.values()].sort((a, b) => b.count - a.count || b.lastTs.localeCompare(a.lastTs));
}

/** Raw counters for the dashboard (recurrence counted, not unique). */
export function countLearnings(jsonl: string | null): { facts: number; pitfalls: number } {
  if (!jsonl) return { facts: 0, pitfalls: 0 };
  let facts = 0, pitfalls = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let j: { kind?: FactKind; hash?: string; text?: string };
    try { j = JSON.parse(line); } catch { continue; }
    if (!j.hash || !j.text || !KINDS.has(j.kind as FactKind)) continue;
    facts++;
    if (j.kind === 'pitfall') pitfalls++;
  }
  return { facts, pitfalls };
}

/* ────────────────────────────────────────────────────────────────────────────
   Ranking + salience (usage) + decay (forgetting). All pure: the I/O (reading
   salience.json, writing the archive) stays on the caller's side. Salience only applies
   to the per-agent staging tier (learnings.jsonl, key = hash); the
   curated project files are "pinned" (never ranked/decayed here).
   ──────────────────────────────────────────────────────────────────────────── */

export type Salience = Record<string, { uses: number; lastUsed: string }>;

/** Enriched search hit (hash/ts for learnings → salience + recency). */
export type Hit = {
  scope: 'project' | 'agent'; id: string; file: string;
  kind?: string; text: string; hash?: string; ts?: string;
};

export function parseSalience(json: string | null): Salience {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const out: Salience = {};
    for (const [k, v] of Object.entries(o ?? {})) {
      if (v && typeof v === 'object') {
        const e = v as { uses?: unknown; lastUsed?: unknown };
        out[k] = { uses: Number(e.uses) || 0, lastUsed: typeof e.lastUsed === 'string' ? e.lastUsed : '' };
      }
    }
    return out;
  } catch { return {}; }
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const FILE_WEIGHT: Record<string, number> = {
  'instructions.md': 2, 'decisions.md': 1.5, 'pieges.md': 1, 'learnings.jsonl': 0.7,
};

/** Relevance score of a hit. Additive signals: matched terms (+ whole-word
 *  bonus), file weight, recency (if ts), salience (if hash known). */
export function scoreHit(hit: Hit, terms: string[], salience: Salience, now: number): number {
  const text = hit.text.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (!t || !text.includes(t)) continue;
    s += 1;
    if (new RegExp(`\\b${escapeRe(t)}\\b`).test(text)) s += 0.5;
  }
  s += FILE_WEIGHT[hit.file] ?? 0.5;
  if (hit.ts) {
    const days = (now - Date.parse(hit.ts)) / 86_400_000;
    if (Number.isFinite(days)) s += Math.max(0, 1 - days / 60); // decreases over ~60 days
  }
  if (hit.hash && salience[hit.hash]) s += Math.min(2, Math.log1p(salience[hit.hash]!.uses));
  return s;
}

/** Sorts the hits by decreasing relevance. `salienceByAgent`: map
 *  agentName → Salience (project hits have no salience). */
export function rankHits(
  hits: Hit[], query: string, salienceByAgent: Record<string, Salience>, now: number,
): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return hits
    .map((h) => ({ h, sc: scoreHit(h, terms, h.scope === 'agent' ? (salienceByAgent[h.id] ?? {}) : {}, now) }))
    .sort((a, b) => b.sc - a.sc)
    .map((x) => x.h);
}

/**
 * Decay (forgetting) of the learnings.jsonl staging tier. Works per hash GROUP
 * (the recurrence counter is per hash): a group is archived when its
 * weight drops below the threshold. Weight = Ebbinghaus curve on the last
 * occurrence, boosted by salience (uses):
 *   weight = 0.5^(ageDays / halfLife) * (1 + ln(1 + uses))
 * Returns the raw lines to keep vs archive (original order preserved).
 */
export function decayLearnings(
  jsonl: string | null,
  salience: Salience,
  now: number,
  opts: { halfLifeDays: number; threshold: number },
): { keep: string[]; archive: string[] } {
  if (!jsonl) return { keep: [], archive: [] };
  const lines = jsonl.split('\n').filter((l) => l.trim());
  // last occurrence (max ts) per hash
  const lastTs = new Map<string, number>();
  for (const line of lines) {
    try {
      const j = JSON.parse(line) as { hash?: string; ts?: string };
      if (!j.hash) continue;
      const t = Date.parse(j.ts ?? '');
      const prev = lastTs.get(j.hash) ?? 0;
      if (Number.isFinite(t) && t > prev) lastTs.set(j.hash, t);
    } catch { /* corrupted line: kept out of caution */ }
  }
  const archiveHash = new Set<string>();
  for (const [hash, ts] of lastTs) {
    const ageDays = (now - ts) / 86_400_000;
    const uses = salience[hash]?.uses ?? 0;
    const weight = Math.pow(0.5, ageDays / opts.halfLifeDays) * (1 + Math.log1p(uses));
    if (weight < opts.threshold) archiveHash.add(hash);
  }
  const keep: string[] = [], archive: string[] = [];
  for (const line of lines) {
    let hash: string | undefined;
    try { hash = (JSON.parse(line) as { hash?: string }).hash; } catch { hash = undefined; }
    (hash && archiveHash.has(hash) ? archive : keep).push(line);
  }
  return { keep, archive };
}
