/**
 * The regex engine of trigger filters. A filter pattern is written by whoever
 * saves a trigger, and the subject comes from a webhook payload: V8's
 * backtracking engine would let `^(a|aa)+$` on a crafted string freeze the
 * daemon, and Node has no regex timeout. No blacklist of "dangerous shapes"
 * can be complete, so the pattern never reaches `RegExp` at all.
 *
 * Instead: a JavaScript-compatible SUBSET compiled to a Thompson NFA and run
 * as a Pike VM — every input position visits each instruction at most once,
 * so a match costs at most `subject length × program size` steps, both
 * bounded (`MAX_PROGRAM`, and the caller's subject cap). A step is O(log r):
 * class ranges are merged and binary-searched, case folding is computed once
 * per position. No backtracking exists to blow up.
 *
 * Semantics follow `new RegExp(pattern, flags).test(subject)` without the `u`,
 * `m` or `s` flags: UTF-16 code units, `^`/`$` at the ends of the subject
 * only, `.` excluding line terminators, `i` by simple case folding.
 *
 * Supported: literals, `.`, classes `[...]` / `[^...]` with ranges, `\d \D
 * \w \W \s \S`, `\b \B`, `\t \n \r \f \v \0 \xHH \uHHHH`, escaped
 * punctuation, groups `(...)` / `(?:...)`, `|`, `* + ? {n} {n,} {n,m}` (lazy
 * suffix accepted, irrelevant to a yes/no test).
 * Refused: backreferences, lookarounds, named groups, `\p{…}`, `\c`, and any
 * unknown escape — a refusal at save time, never a surprise at run time.
 */

export class SafeRegexError extends Error {}

/** Instructions of a compiled program; the cost bound is linear in this.
 *  Callers holding several patterns budget their SUM (filter.ts). */
export const MAX_PROGRAM = 2000;
/** Largest counted repetition — the program cap is the real bound. */
const MAX_COUNT = 1000;
/** Calls to `Compiler.compile`, whatever they emit. `simplify` already makes
 *  the walk proportional to the program; this stays as the general bound so
 *  that no AST shape can make saving a filter expensive. */
const MAX_COMPILE_STEPS = 64 * MAX_PROGRAM;

type Range = readonly [number, number];
type CharSet = { negate: boolean; ranges: Range[] };
type Assertion = 'start' | 'end' | 'word' | 'not_word';

type Node =
  | { kind: 'set'; set: CharSet }
  | { kind: 'assert'; assert: Assertion }
  | { kind: 'seq'; items: Node[] }
  | { kind: 'alt'; options: Node[] }
  | { kind: 'repeat'; node: Node; min: number; max: number | null };

const DIGIT: Range[] = [[0x30, 0x39]];
const WORD: Range[] = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
/** `\s` as ECMAScript defines it: WhiteSpace + LineTerminator. */
const SPACE: Range[] = [
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
];
const LINE_TERMINATORS: Range[] = [[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]];

function complement(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  let next = 0;
  for (const [lo, hi] of sorted) {
    if (lo > next) out.push([next, lo - 1]);
    next = Math.max(next, hi + 1);
  }
  if (next <= 0xffff) out.push([next, 0xffff]);
  return out;
}

const CLASS_ESCAPES: Record<string, Range[]> = {
  d: DIGIT, D: complement(DIGIT), w: WORD, W: complement(WORD), s: SPACE, S: complement(SPACE),
};
const CONTROL_ESCAPES: Record<string, number> = { t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d };

const single = (code: number): CharSet => ({ negate: false, ranges: [[code, code]] });

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): Node {
    const node = this.alternation();
    if (this.pos < this.src.length) throw new SafeRegexError(`unexpected "${this.src[this.pos]}"`);
    return node;
  }

  private peek(): string | undefined { return this.src[this.pos]; }

  private alternation(): Node {
    const options = [this.sequence()];
    while (this.peek() === '|') { this.pos++; options.push(this.sequence()); }
    return options.length === 1 ? options[0]! : { kind: 'alt', options };
  }

  private sequence(): Node {
    const items: Node[] = [];
    while (this.pos < this.src.length && this.peek() !== '|' && this.peek() !== ')') {
      const atom = this.atom();
      items.push(this.quantified(atom));
    }
    return { kind: 'seq', items };
  }

  private quantified(atom: Node): Node {
    const c = this.peek();
    let min: number; let max: number | null;
    if (c === '*') { min = 0; max = null; this.pos++; }
    else if (c === '+') { min = 1; max = null; this.pos++; }
    else if (c === '?') { min = 0; max = 1; this.pos++; }
    else if (c === '{') {
      const m = /^\{(\d{1,4})(,(\d{0,4}))?\}/.exec(this.src.slice(this.pos));
      if (!m) throw new SafeRegexError('invalid quantifier (escape a literal "{" as "\\{")');
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === '' ? null : Number(m[3]);
      if (min > MAX_COUNT || (max !== null && max > MAX_COUNT)) throw new SafeRegexError(`repetition above ${MAX_COUNT}`);
      if (max !== null && max < min) throw new SafeRegexError('numbers out of order in quantifier');
      this.pos += m[0].length;
    } else {
      return atom;
    }
    if (atom.kind === 'assert') throw new SafeRegexError('nothing to repeat');
    if (this.peek() === '?') this.pos++;
    const after = this.peek();
    if (after === '*' || after === '+' || after === '?' || after === '{') throw new SafeRegexError('nothing to repeat');
    return { kind: 'repeat', node: atom, min, max };
  }

  private atom(): Node {
    const c = this.src[this.pos++]!;
    switch (c) {
      case '^': return { kind: 'assert', assert: 'start' };
      case '$': return { kind: 'assert', assert: 'end' };
      case '.': return { kind: 'set', set: { negate: true, ranges: LINE_TERMINATORS } };
      case '[': return { kind: 'set', set: this.charClass() };
      case '(': {
        if (this.peek() === '?') {
          if (this.src[this.pos + 1] !== ':') throw new SafeRegexError('lookarounds and named groups are not supported');
          this.pos += 2;
        }
        const inner = this.alternation();
        if (this.peek() !== ')') throw new SafeRegexError('unterminated group');
        this.pos++;
        return inner;
      }
      case ')': throw new SafeRegexError('unmatched ")"');
      case '*': case '+': case '?': case '{': throw new SafeRegexError('nothing to repeat');
      case '\\': return this.escape(false);
      default: return { kind: 'set', set: single(c.charCodeAt(0)) };
    }
  }

  /** After a backslash. Inside a class `\b` is a backspace, not an assertion. */
  private escape(inClass: boolean): Node {
    const c = this.src[this.pos++];
    if (c === undefined) throw new SafeRegexError('\\ at end of pattern');
    if (CLASS_ESCAPES[c]) return { kind: 'set', set: { negate: false, ranges: CLASS_ESCAPES[c] } };
    if (c === 'b') return inClass ? { kind: 'set', set: single(0x08) } : { kind: 'assert', assert: 'word' };
    if (c === 'B' && !inClass) return { kind: 'assert', assert: 'not_word' };
    if (CONTROL_ESCAPES[c] !== undefined) return { kind: 'set', set: single(CONTROL_ESCAPES[c]) };
    if (c === '0' && !/[0-9]/.test(this.peek() ?? '')) return { kind: 'set', set: single(0) };
    if (c === 'x' || c === 'u') {
      const len = c === 'x' ? 2 : 4;
      const hex = this.src.slice(this.pos, this.pos + len);
      if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw new SafeRegexError(`invalid \\${c} escape`);
      this.pos += len;
      return { kind: 'set', set: single(parseInt(hex, 16)) };
    }
    if (/[0-9]/.test(c)) throw new SafeRegexError('backreferences are not supported');
    if (/[A-Za-z]/.test(c)) throw new SafeRegexError(`unsupported escape \\${c}`);
    return { kind: 'set', set: single(c.charCodeAt(0)) };
  }

  /** One class member: a single code unit, or a class escape (`\d`…). */
  private classAtom(): { code: number } | { ranges: Range[] } {
    const c = this.src[this.pos++]!;
    if (c !== '\\') return { code: c.charCodeAt(0) };
    if (this.peek() === 'B') throw new SafeRegexError('unsupported escape \\B in a class');
    const node = this.escape(true);
    if (node.kind !== 'set') throw new SafeRegexError('invalid class escape');
    const r = node.set.ranges;
    return r.length === 1 && r[0]![0] === r[0]![1] && !node.set.negate ? { code: r[0]![0] } : { ranges: r };
  }

  private charClass(): CharSet {
    const negate = this.peek() === '^';
    if (negate) this.pos++;
    const ranges: Range[] = [];
    while (this.peek() !== ']') {
      if (this.pos >= this.src.length) throw new SafeRegexError('unterminated character class');
      const first = this.classAtom();
      if (this.peek() === '-' && this.src[this.pos + 1] !== ']' && this.src[this.pos + 1] !== undefined) {
        this.pos++;
        const last = this.classAtom();
        if (!('code' in first) || !('code' in last)) throw new SafeRegexError('invalid range in character class');
        if (last.code < first.code) throw new SafeRegexError('range out of order in character class');
        ranges.push([first.code, last.code]);
        continue;
      }
      if ('code' in first) ranges.push([first.code, first.code]);
      else ranges.push(...first.ranges);
    }
    this.pos++;
    return { negate, ranges };
  }
}

// ── compilation ──────────────────────────────────────────────────────────────

const EMPTY: Node = { kind: 'seq', items: [] };
const isEmpty = (node: Node): boolean => node.kind === 'seq' && node.items.length === 0;
const saturate = (n: number): number => Math.min(n, MAX_PROGRAM + 1);

/**
 * One pass over the AST, before any expansion: the exact instruction count
 * the compiler would emit (saturated past the cap), and the tree with every
 * node that emits nothing removed. Without it, `((){1000}){1000}` expands a
 * million empty sequences — and `((((){1000}){1000}){1000}){1000}` 10^12 —
 * without ever reaching `emit` and its cap. Dropping an empty node changes
 * nothing: it compiled to no instruction at all.
 */
function simplify(node: Node): { node: Node; size: number } {
  switch (node.kind) {
    case 'set': case 'assert': return { node, size: 1 };
    case 'seq': {
      const items: Node[] = [];
      let size = 0;
      for (const item of node.items) {
        const s = simplify(item);
        if (s.size === 0) continue;
        // Nested sequences flattened: a group's depth costs no compile step.
        if (s.node.kind === 'seq') items.push(...s.node.items); else items.push(s.node);
        size = saturate(size + s.size);
      }
      return { node: items.length === 1 ? items[0]! : { kind: 'seq', items }, size };
    }
    case 'alt': {
      // split + jmp around every option but the last.
      let size = 2 * (node.options.length - 1);
      const options = node.options.map((option) => {
        const s = simplify(option);
        size = saturate(size + s.size);
        return s.node;
      });
      return { node: { kind: 'alt', options }, size: saturate(size) };
    }
    case 'repeat': {
      const body = simplify(node.node);
      const size = node.max === null
        ? body.size * node.min + body.size + 2
        : body.size * node.min + (node.max - node.min) * (body.size + 1);
      if (size === 0) return { node: EMPTY, size: 0 };
      return { node: { ...node, node: body.node }, size: saturate(size) };
    }
  }
}

type Inst =
  | { op: 'char'; set: CharSet }
  | { op: 'assert'; assert: Assertion }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; to: number }
  | { op: 'match' };

class Compiler {
  readonly prog: Inst[] = [];
  steps = 0;

  private emit(inst: Inst): number {
    if (this.prog.length >= MAX_PROGRAM) throw new SafeRegexError('regex too complex');
    this.prog.push(inst);
    return this.prog.length - 1;
  }

  compile(node: Node): void {
    if (++this.steps > MAX_COMPILE_STEPS) throw new SafeRegexError('regex too complex');
    switch (node.kind) {
      case 'set': this.emit({ op: 'char', set: node.set }); return;
      case 'assert': this.emit({ op: 'assert', assert: node.assert }); return;
      case 'seq': for (const item of node.items) this.compile(item); return;
      case 'alt': {
        // split L1, next ; L1: option ; jmp end ; next: split …
        const jumps: number[] = [];
        node.options.forEach((option, i) => {
          if (i < node.options.length - 1) {
            const split = this.emit({ op: 'split', x: 0, y: 0 });
            (this.prog[split] as { x: number }).x = this.prog.length;
            this.compile(option);
            jumps.push(this.emit({ op: 'jmp', to: 0 }));
            (this.prog[split] as { y: number }).y = this.prog.length;
          } else {
            this.compile(option);
          }
        });
        for (const j of jumps) (this.prog[j] as { to: number }).to = this.prog.length;
        return;
      }
      case 'repeat': {
        if (!isEmpty(node.node)) for (let i = 0; i < node.min; i++) this.compile(node.node);
        if (node.max === null) {
          // L: split body, end ; body ; jmp L
          const split = this.emit({ op: 'split', x: 0, y: 0 });
          (this.prog[split] as { x: number }).x = this.prog.length;
          this.compile(node.node);
          this.emit({ op: 'jmp', to: split });
          (this.prog[split] as { y: number }).y = this.prog.length;
          return;
        }
        const splits: number[] = [];
        for (let i = node.min; i < node.max; i++) {
          const split = this.emit({ op: 'split', x: 0, y: 0 });
          (this.prog[split] as { x: number }).x = this.prog.length;
          splits.push(split);
          this.compile(node.node);
        }
        for (const s of splits) (this.prog[s] as { y: number }).y = this.prog.length;
        return;
      }
    }
  }
}

// ── execution ────────────────────────────────────────────────────────────────

/** Sorted, non-overlapping, adjacent ranges joined, flattened `[lo, hi, …]`. */
function flatten(ranges: readonly Range[]): Int32Array {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [lo, hi] of sorted) {
    const last = out.length - 1;
    if (last > 0 && lo <= out[last]! + 1) out[last] = Math.max(out[last]!, hi);
    else out.push(lo, hi);
  }
  return Int32Array.from(out);
}

/** Binary search: a class of 100 ranges costs 7 comparisons, not 100. */
function inRanges(flat: Int32Array, code: number): boolean {
  let lo = 0;
  let hi = (flat.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (code < flat[mid * 2]!) hi = mid - 1;
    else if (code > flat[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

function fold(code: number, to: 'upper' | 'lower'): number {
  const ch = String.fromCharCode(code);
  const out = to === 'upper' ? ch.toUpperCase() : ch.toLowerCase();
  return out.length === 1 ? out.charCodeAt(0) : code;
}

const WORD_FLAT = flatten(WORD);
const isWord = (subject: string, i: number): boolean =>
  i >= 0 && i < subject.length && inRanges(WORD_FLAT, subject.charCodeAt(i));

const ASSERTIONS: readonly Assertion[] = ['start', 'end', 'word', 'not_word'];

function assertionHolds(assert: Assertion, subject: string, i: number): boolean {
  switch (assert) {
    case 'start': return i === 0;
    case 'end': return i === subject.length;
    case 'word': return isWord(subject, i - 1) !== isWord(subject, i);
    case 'not_word': return isWord(subject, i - 1) === isWord(subject, i);
  }
}

/** Work done by `test`, for callers (and tests) that check the linear bound
 *  instead of timing it: a timing depends on the machine's load, this does not. */
export type StepMeter = { steps: number };

export type SafeRegex = {
  /** `meter.steps` grows by the instructions visited: at most
   *  `(subject.length + 2) × (3 × size + 1)`, whatever the pattern. */
  test(subject: string, meter?: StepMeter): boolean;
  /** Instructions: the per-position cost bound, for budgets across patterns. */
  readonly size: number;
};

const OP_CHAR = 0;
const OP_ASSERT = 1;
const OP_SPLIT = 2;
const OP_JMP = 3;
const OP_MATCH = 4;

/** Throws `SafeRegexError` for anything outside the subset. `meter.steps`
 *  grows by the compile walk, refused or not: at most `MAX_COMPILE_STEPS`. */
export function compileSafeRegex(pattern: string, flags: '' | 'i' = '', meter?: StepMeter): SafeRegex {
  const { node, size } = simplify(new Parser(pattern).parse());
  // Refused before a single instruction is expanded.
  if (size > MAX_PROGRAM) throw new SafeRegexError('regex too complex');
  const compiler = new Compiler();
  try {
    compiler.compile(node);
  } finally {
    if (meter) meter.steps += compiler.steps;
  }
  compiler.prog.push({ op: 'match' });
  const source = compiler.prog;
  const len = source.length;

  // Flat program. A class repeated by `{n}` is ONE set object in the AST, so
  // it gets one index here, and its answer is computed once per position.
  const op = new Uint8Array(len);
  const a = new Int32Array(len);
  const b = new Int32Array(len);
  const setIndex = new Map<CharSet, number>();
  const sets: Array<{ negate: boolean; flat: Int32Array }> = [];
  source.forEach((inst, pc) => {
    switch (inst.op) {
      case 'char': {
        let index = setIndex.get(inst.set);
        if (index === undefined) {
          index = sets.length;
          setIndex.set(inst.set, index);
          sets.push({ negate: inst.set.negate, flat: flatten(inst.set.ranges) });
        }
        op[pc] = OP_CHAR; a[pc] = index; return;
      }
      case 'assert': op[pc] = OP_ASSERT; a[pc] = ASSERTIONS.indexOf(inst.assert); return;
      case 'split': op[pc] = OP_SPLIT; a[pc] = inst.x; b[pc] = inst.y; return;
      case 'jmp': op[pc] = OP_JMP; a[pc] = inst.to; return;
      case 'match': op[pc] = OP_MATCH; return;
    }
  });
  const ignoreCase = flags === 'i';

  return {
    size: len,
    test(subject: string, meter?: StepMeter): boolean {
      let steps = 0;
      // `mark[pc] === generation` = pc already in this step's list: each
      // instruction enters a list at most once per position — the linear bound.
      const mark = new Int32Array(len).fill(-1);
      const setStamp = new Int32Array(sets.length).fill(-1);
      const setHit = new Uint8Array(sets.length);
      let generation = 0;
      let current = new Int32Array(len);
      let next = new Int32Array(len);
      let currentCount = 0;
      let nextCount = 0;
      // Every push follows an edge (≤ 2 per instruction) or starts a thread.
      const stack = new Int32Array(3 * len + 2);

      /** Epsilon closure of `start` at `pos`, into the list being built. */
      const add = (into: Int32Array, count: number, start: number, pos: number): number => {
        let sp = 0;
        stack[sp++] = start;
        while (sp > 0) {
          const pc = stack[--sp]!;
          steps++;
          if (mark[pc] === generation) continue;
          mark[pc] = generation;
          switch (op[pc]) {
            case OP_JMP: stack[sp++] = a[pc]!; break;
            case OP_SPLIT: stack[sp++] = b[pc]!; stack[sp++] = a[pc]!; break;
            case OP_ASSERT: if (assertionHolds(ASSERTIONS[a[pc]!]!, subject, pos)) stack[sp++] = pc + 1; break;
            default: into[count++] = pc;
          }
        }
        return count;
      };

      for (let pos = 0; pos <= subject.length; pos++) {
        // Unanchored search: a fresh thread may start at every position.
        currentCount = add(current, currentCount, 0, pos);
        generation++;
        const code = pos < subject.length ? subject.charCodeAt(pos) : -1;
        // Once per position, never per thread.
        const upper = ignoreCase && code !== -1 ? fold(code, 'upper') : code;
        const lower = ignoreCase && code !== -1 ? fold(code, 'lower') : code;
        for (let i = 0; i < currentCount; i++) {
          const pc = current[i]!;
          if (op[pc] === OP_MATCH) {
            if (meter) meter.steps += steps;
            return true;
          }
          if (code === -1) continue;
          const set = a[pc]!;
          if (setStamp[set] !== pos) {
            const { negate, flat } = sets[set]!;
            const hit = inRanges(flat, code)
              || (upper !== code && inRanges(flat, upper))
              || (lower !== code && inRanges(flat, lower));
            setHit[set] = hit !== negate ? 1 : 0;
            setStamp[set] = pos;
          }
          if (setHit[set] === 1) nextCount = add(next, nextCount, pc + 1, pos + 1);
        }
        [current, next] = [next, current];
        currentCount = nextCount;
        nextCount = 0;
      }
      if (meter) meter.steps += steps;
      return false;
    },
  };
}
