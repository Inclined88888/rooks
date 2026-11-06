/**
 * `engines.node` of a plugin package against the Node that will run it
 * (TODO #763).
 *
 * A plugin's host half is imported by the daemon, inside the daemon's own
 * process: the Node that matters is the daemon's, never the one on the
 * operator's PATH. A packaged Timon runs on the runtime it ships (Electron used
 * as Node, or a bundled Node binary), whose version has nothing to do with the
 * system Node. A package that needs `node:sqlite` (`>=22.5`) installed on a
 * daemon running Electron 33 (Node 20.18) used to fail later, with an error
 * that pointed nowhere near the cause.
 *
 * `semver` is only a transitive dependency of the orchestrator, so it is not
 * imported (AGENTS.md rule 12): the range forms npm documents for `engines`
 * are evaluated here. A range this reader does not understand is never a
 * refusal — the package is let through, and `timon plugin check` warns.
 *
 * Prerelease tags are ignored on both sides: an `engines` range is about
 * release lines, and a nightly runtime is not what testers run.
 */
import { BRAND } from '../brand.js';
import { packagedRuntime } from '../host/bundled-node.js';

type Triple = readonly [number, number, number];
type Comparator = { op: '<' | '<=' | '>' | '>=' | '='; v: Triple };

/** The Node a plugin would run on, and where that answer came from. */
export type NodeRuntimeFacts = {
  /** `process.versions.node` of the process that runs plugins. */
  node: string;
  /** Electron version when that Node is Electron's, otherwise `null`. */
  electron: string | null;
  /** Runs on a desktop package's own runtime, not a Node installed on the machine. */
  packaged: boolean;
  /**
   * `daemon`: the daemon's own runtime (asked over the API, or this process
   * is the daemon). `local`: the CLI's Node, used only because the daemon
   * could not be reached — an estimate, said so in the message.
   */
  source: 'daemon' | 'local';
};

/** The runtime of THIS process, as the daemon sees itself. */
export function currentNodeRuntime(source: NodeRuntimeFacts['source'] = 'daemon'): NodeRuntimeFacts {
  return {
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    packaged: packagedRuntime(),
    source,
  };
}

/** `engines.node` of a `package.json`, trimmed; `null` when absent or empty. */
export function nodeEngineRange(packageJson: unknown): string | null {
  if (typeof packageJson !== 'object' || packageJson === null) return null;
  const engines = (packageJson as { engines?: unknown }).engines;
  if (typeof engines !== 'object' || engines === null) return null;
  const node = (engines as { node?: unknown }).node;
  return typeof node === 'string' && node.trim() ? node.trim() : null;
}

const WILD = /^[xX*]$/;
const PART = /^v?=?\s*([0-9]+|[xX*])(?:\.([0-9]+|[xX*]))?(?:\.([0-9]+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version as written in a range: up to three parts, `null` past the last given one. */
type Partial = [number | null, number | null, number | null];

function parsePartial(text: string): Partial | null {
  const m = PART.exec(text);
  if (!m) return null;
  const out: Partial = [null, null, null];
  for (let i = 0; i < 3; i += 1) {
    const raw = m[i + 1];
    if (raw === undefined || WILD.test(raw)) break;
    out[i] = Number(raw);
  }
  return out;
}

function filled(p: Partial): Triple {
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

/** The first version past what a partial covers: `1` → `2.0.0`, `1.2` → `1.3.0`. */
function nextAfter(p: Partial): Triple | null {
  if (p[0] === null) return null;
  if (p[1] === null) return [p[0] + 1, 0, 0];
  if (p[2] === null) return [p[0], p[1] + 1, 0];
  return null;
}

function precise(p: Partial): p is [number, number, number] {
  return p[2] !== null;
}

/** One token of a comparator set (`>=22.5`, `^20`, `1.x`), as comparators; `null` if unreadable. */
function comparatorsOf(token: string): Comparator[] | null {
  const m = /^(<=|>=|<|>|=|~>|~|\^)?(.*)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? '';
  const p = parsePartial(m[2] ?? '');
  if (!p) return null;
  if (p[0] === null) return op === '<' || op === '>' ? [{ op: '<', v: [0, 0, 0] }] : [];
  const next = nextAfter(p);
  switch (op) {
    case '>=': return [{ op: '>=', v: filled(p) }];
    case '>': return next ? [{ op: '>=', v: next }] : [{ op: '>', v: filled(p) }];
    case '<': return [{ op: '<', v: filled(p) }];
    case '<=': return next ? [{ op: '<', v: next }] : [{ op: '<=', v: filled(p) }];
    case '~':
    case '~>': {
      const upper: Triple = p[1] === null ? [p[0] + 1, 0, 0] : [p[0], p[1] + 1, 0];
      return [{ op: '>=', v: filled(p) }, { op: '<', v: upper }];
    }
    case '^': {
      const [a, b, c] = filled(p);
      let upper: Triple;
      if (a > 0 || p[1] === null) upper = [a + 1, 0, 0];
      else if (b > 0 || p[2] === null) upper = [0, b + 1, 0];
      else upper = [0, 0, c + 1];
      return [{ op: '>=', v: [a, b, c] }, { op: '<', v: upper }];
    }
    default:
      if (precise(p)) return [{ op: '=', v: p }];
      return [{ op: '>=', v: filled(p) }, ...(next ? [{ op: '<' as const, v: next }] : [])];
  }
}

/** One `||` alternative; `null` if any part of it is unreadable. */
function comparatorSet(text: string): Comparator[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (hyphen) {
    const low = parsePartial(hyphen[1] ?? '');
    const high = parsePartial(hyphen[2] ?? '');
    if (!low || !high) return null;
    const out: Comparator[] = low[0] === null ? [] : [{ op: '>=', v: filled(low) }];
    if (high[0] === null) return out;
    const next = nextAfter(high);
    out.push(next ? { op: '<', v: next } : { op: '<=', v: filled(high) });
    return out;
  }
  // `>= 22.5` is the same token as `>=22.5`: glue an operator to its version.
  const tokens = trimmed.replace(/(<=|>=|<|>|=|~>|~|\^)\s+/g, '$1').split(/\s+/);
  const out: Comparator[] = [];
  for (const token of tokens) {
    const part = comparatorsOf(token);
    if (!part) return null;
    out.push(...part);
  }
  return out;
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function holds(c: Comparator, v: Triple): boolean {
  const d = compare(v, c.v);
  switch (c.op) {
    case '<': return d < 0;
    case '<=': return d <= 0;
    case '>': return d > 0;
    case '>=': return d >= 0;
    case '=': return d === 0;
  }
}

/**
 * Does `version` (a runtime's `process.versions.node`) satisfy `range`?
 * `null` when either is unreadable: the caller lets the package through.
 */
export function nodeRangeSatisfied(range: string, version: string): boolean | null {
  const v = parsePartial(version.trim());
  if (!v || !precise(v)) return null;
  const sets: Comparator[][] = [];
  for (const alternative of range.split('||')) {
    const set = comparatorSet(alternative);
    if (!set) return null;
    sets.push(set);
  }
  return sets.some((set) => set.every((c) => holds(c, v)));
}

/** What a reader of the refusal is told the Node is, and why it is that one. */
function runtimeLine(runtime: NodeRuntimeFacts): string {
  const name = BRAND.displayName;
  if (runtime.source === 'local') {
    return `this machine's Node is ${runtime.node} (the ${name} daemon could not be reached to ask for its own, which is the one that decides)`;
  }
  const own = runtime.electron ? `the Node of Electron ${runtime.electron}` : 'the Node it ships';
  return runtime.packaged
    ? `this ${name} daemon runs Node ${runtime.node}. A packaged ${name} runs plugins on its own runtime (${own}), not on the Node installed on this system: upgrading the system Node changes nothing`
    : `this ${name} daemon runs Node ${runtime.node}`;
}

/**
 * The refusal message when the package's `engines.node` excludes the runtime,
 * `null` when it does not (no range, an unreadable one, or a match).
 */
export function nodeEngineProblem(packageJson: unknown, label: string, runtime: NodeRuntimeFacts): string | null {
  const range = nodeEngineRange(packageJson);
  if (!range) return null;
  if (nodeRangeSatisfied(range, runtime.node) !== false) return null;
  return `plugin \`${label}\` requires Node ${range} (engines.node), but ${runtimeLine(runtime)}. `
    + `Install a release of the plugin that supports Node ${runtime.node}, or a ${BRAND.displayName} version whose runtime satisfies ${range}.`;
}
