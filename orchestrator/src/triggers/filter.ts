/**
 * Declarative filters of a trigger, evaluated after authentication and body
 * parsing and before any action. A closed vocabulary on purpose: no script,
 * no expression language — what a filter can do is what this file says.
 *
 *   { "all": [ { "op": "equals", "path": "action", "value": "opened" },
 *              { "op": "contains", "path": "issue.labels.0.name", "value": "bug" } ] }
 */
import { z } from 'zod';
import { lookup, PATH_RE, type TriggerInput } from './payload.js';
import { compileSafeRegex, MAX_PROGRAM, SafeRegexError, type SafeRegex } from './safe-regex.js';
import type { Filter as ContractFilter, FilterLeaf as ContractFilterLeaf } from '../plugins/contract/automation.js';
import type { Assert, Equals } from '../type-equality.js';

const scalar = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const path = z.string().min(1).max(200).regex(PATH_RE, 'invalid path');

/** Bounds of a filter tree: it is config, but a huge one is a cheap DoS. */
const MAX_DEPTH = 8;
const MAX_NODES = 64;
/**
 * A regex only ever sees this much of a value. With the linear engine of
 * `safe-regex.ts`, one evaluation costs at most this × its program size.
 */
export const REGEX_SUBJECT_MAX = 4096;
/**
 * Program size of ALL the regex leaves of one filter together: 63 leaves at
 * the per-pattern cap would multiply the worst case by 63, on every call.
 */
export const REGEX_FILTER_BUDGET = MAX_PROGRAM;
/** Compiled patterns, keyed by flags + pattern: filters run on every call. */
const compiled = new Map<string, SafeRegex>();

function regexFor(pattern: string, flags: '' | 'i'): SafeRegex {
  const key = `${flags}/${pattern}`;
  let re = compiled.get(key);
  if (!re) {
    re = compileSafeRegex(pattern, flags);
    if (compiled.size >= 500) compiled.clear();
    compiled.set(key, re);
  }
  return re;
}

const leafSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('exists'), path }).strict(),
  z.object({ op: z.literal('missing'), path }).strict(),
  z.object({ op: z.literal('equals'), path, value: scalar }).strict(),
  z.object({ op: z.literal('not_equals'), path, value: scalar }).strict(),
  z.object({ op: z.literal('contains'), path, value: z.union([z.string().min(1).max(1000), z.number(), z.boolean()]) }).strict(),
  z.object({ op: z.literal('in'), path, values: z.array(scalar).min(1).max(100) }).strict(),
  z.object({
    op: z.literal('regex'), path,
    pattern: z.string().min(1).max(256),
    flags: z.enum(['', 'i']).optional(),
  }).strict(),
]);

export type FilterLeaf = z.infer<typeof leafSchema>;
export type Filter =
  | FilterLeaf
  | { all: Filter[] }
  | { any: Filter[] }
  | { not: Filter };
/** The public contract spells the schema out; compilation fails if they part. */
type _FilterMatchesContract = Assert<Equals<Filter, ContractFilter>>;
type _FilterLeafMatchesContract = Assert<Equals<FilterLeaf, ContractFilterLeaf>>;

const filterNode: z.ZodType<Filter> = z.lazy(() => z.union([
  leafSchema,
  z.object({ all: z.array(filterNode).min(1).max(32) }).strict(),
  z.object({ any: z.array(filterNode).min(1).max(32) }).strict(),
  z.object({ not: filterNode }).strict(),
]));

function measure(filter: Filter, depth: number): { depth: number; nodes: number } {
  if ('all' in filter || 'any' in filter) {
    const children = 'all' in filter ? filter.all : filter.any;
    return children.reduce((acc, child) => {
      const m = measure(child, depth + 1);
      return { depth: Math.max(acc.depth, m.depth), nodes: acc.nodes + m.nodes };
    }, { depth, nodes: 1 });
  }
  if ('not' in filter) {
    const m = measure(filter.not, depth + 1);
    return { depth: m.depth, nodes: m.nodes + 1 };
  }
  return { depth, nodes: 1 };
}

function regexLeaves(filter: Filter): Array<Extract<FilterLeaf, { op: 'regex' }>> {
  if ('all' in filter || 'any' in filter) return ('all' in filter ? filter.all : filter.any).flatMap(regexLeaves);
  if ('not' in filter) return regexLeaves(filter.not);
  return filter.op === 'regex' ? [filter] : [];
}

function regexProblem(filter: Filter): string | null {
  let total = 0;
  for (const leaf of regexLeaves(filter)) {
    try { total += regexFor(leaf.pattern, leaf.flags ?? '').size; } catch (err) {
      return err instanceof SafeRegexError ? `regex: ${err.message}` : 'invalid regex';
    }
  }
  return total > REGEX_FILTER_BUDGET ? 'regex: patterns of this filter too complex together' : null;
}

export const filterSchema: z.ZodType<Filter> = filterNode.superRefine((filter, ctx) => {
  const { depth, nodes } = measure(filter, 1);
  if (depth > MAX_DEPTH) ctx.addIssue({ code: 'custom', message: `filter deeper than ${MAX_DEPTH}` });
  if (nodes > MAX_NODES) ctx.addIssue({ code: 'custom', message: `filter larger than ${MAX_NODES} nodes` });
  const problem = regexProblem(filter);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Headers are strings and JSON numbers are numbers: `"42"` equals `42`.
 * Nothing looser — `null` only equals `null`.
 */
function scalarEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  return isPrimitive(actual) && isPrimitive(expected) && String(actual) === String(expected);
}

function evaluateLeaf(leaf: FilterLeaf, input: TriggerInput): boolean {
  const actual = lookup(input, leaf.path);
  switch (leaf.op) {
    case 'exists': return actual !== undefined && actual !== null;
    case 'missing': return actual === undefined || actual === null;
    case 'equals': return scalarEquals(actual, leaf.value);
    case 'not_equals': return !scalarEquals(actual, leaf.value);
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(leaf.value));
      if (Array.isArray(actual)) return actual.some((item) => scalarEquals(item, leaf.value));
      return false;
    case 'in': return leaf.values.some((value) => scalarEquals(actual, value));
    case 'regex':
      if (!isPrimitive(actual)) return false;
      return regexFor(leaf.pattern, leaf.flags ?? '').test(String(actual).slice(0, REGEX_SUBJECT_MAX));
  }
}

/** True when the input passes. A missing filter always passes. */
export function evaluateFilter(filter: Filter | null | undefined, input: TriggerInput): boolean {
  if (!filter) return true;
  if ('all' in filter) return filter.all.every((child) => evaluateFilter(child, input));
  if ('any' in filter) return filter.any.some((child) => evaluateFilter(child, input));
  if ('not' in filter) return !evaluateFilter(filter.not, input);
  return evaluateLeaf(filter, input);
}

/** Paths of an event payload (`events.ts`) that carry an agent name. */
const AGENT_PATHS: ReadonlySet<string> = new Set(['task.agent', 'mission.agent', 'message.from_agent', 'message.to_agent']);

const escapeRegexLiteral = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An agent rename applied to a stored event filter. `equals`, `not_equals` and
 * `in` on an agent path compare exactly, so the old name is swapped for the
 * new one. So is a leaf that spells exactly the old name and nothing else: a
 * `contains`, a regex `^name$` or a bare regex `name`. Anything else that the
 * rename stops (or starts) matching cannot be rewritten without guessing what
 * was meant: it is left as is and flagged `unsure`.
 *
 * `otherAgents` are the other names of the install. A substring that also
 * reads one of them (`contains: "ops"` next to `ops.backup`) may have meant the
 * family, and a new name that reads one would widen the filter to it: flagged,
 * never rewritten. `^name$` matches one agent whatever the others are called.
 */
export function renameAgentInEventFilter(
  filter: unknown,
  oldName: string,
  newName: string,
  otherAgents: readonly string[] = [],
): { filter: unknown; changed: boolean; unsure: boolean } {
  const first = rewriteAgentName(filter, oldName, newName, otherAgents, true);
  // A longer name can push a regex over the limits every save enforces, and
  // the trigger could then no longer be saved. Reported instead.
  const outcome = first.regexRewritten && !filterSchema.safeParse(first.filter).success
    ? rewriteAgentName(filter, oldName, newName, otherAgents, false)
    : first;
  return { filter: outcome.changed ? outcome.filter : filter, changed: outcome.changed, unsure: outcome.unsure };
}

function rewriteAgentName(
  filter: unknown,
  oldName: string,
  newName: string,
  otherAgents: readonly string[],
  rewriteRegex: boolean,
): { filter: unknown; changed: boolean; unsure: boolean; regexRewritten: boolean } {
  let changed = false;
  let unsure = false;
  let regexRewritten = false;
  const swap = (v: unknown): unknown => {
    if (v === oldName) { changed = true; return newName; }
    return v;
  };
  const readsAnother = (needle: string, flags: '' | 'i'): boolean => otherAgents.some((agent) => (
    flags === 'i' ? agent.toLowerCase().includes(needle.toLowerCase()) : agent.includes(needle)
  ));
  const substringIsThisAgentOnly = (flags: '' | 'i'): boolean => !readsAnother(oldName, flags) && !readsAnother(newName, flags);
  const walk = (node: unknown): unknown => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.all)) return { ...n, all: n.all.map(walk) };
    if (Array.isArray(n.any)) return { ...n, any: n.any.map(walk) };
    if ('not' in n) return { ...n, not: walk(n.not) };
    if (typeof n.path !== 'string' || !AGENT_PATHS.has(n.path)) return node;
    switch (n.op) {
      case 'equals':
      case 'not_equals':
        return 'value' in n ? { ...n, value: swap(n.value) } : node;
      case 'in':
        return Array.isArray(n.values) ? { ...n, values: n.values.map(swap) } : node;
      case 'contains':
        if (n.value !== undefined && oldName.includes(String(n.value)) !== newName.includes(String(n.value))) {
          if (n.value === oldName && substringIsThisAgentOnly('')) { changed = true; return { ...n, value: newName }; }
          unsure = true;
        }
        return node;
      case 'regex':
        // Flagged only when the rename changes the outcome for this agent.
        if (typeof n.pattern === 'string') {
          const flags = n.flags === 'i' ? 'i' : '';
          try {
            const re = regexFor(n.pattern, flags);
            if (re.test(oldName) === re.test(newName)) return node;
          } catch { return node; /* an invalid pattern never matched anyone */ }
          if (rewriteRegex && n.pattern === `^${escapeRegexLiteral(oldName)}$`) {
            changed = true;
            regexRewritten = true;
            return { ...n, pattern: `^${escapeRegexLiteral(newName)}$` };
          }
          if (rewriteRegex && n.pattern === escapeRegexLiteral(oldName) && substringIsThisAgentOnly(flags)) {
            changed = true;
            regexRewritten = true;
            return { ...n, pattern: escapeRegexLiteral(newName) };
          }
          unsure = true;
        }
        return node;
      default:
        return node;
    }
  };
  const next = walk(filter);
  return { filter: next, changed, unsure, regexRewritten };
}
