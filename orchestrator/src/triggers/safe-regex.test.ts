import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSafeRegex, MAX_PROGRAM, SafeRegexError, type SafeRegex, type StepMeter } from './safe-regex.js';
import { evaluateFilter, filterSchema, REGEX_FILTER_BUDGET, REGEX_SUBJECT_MAX } from './filter.js';

/** Patterns of the subset, checked against V8 on subjects of every shape. */
const PATTERNS: Array<[string, '' | 'i']> = [
  ['abc', ''], ['^abc$', ''], ['a.c', ''], ['^crash', 'i'], ['colou?r', ''], ['ab*c', ''], ['ab+c', ''],
  ['a{2}', ''], ['^a{2,3}$', ''], ['^a{2,}$', ''], ['x{0}y', ''], ['(foo|bar)+baz', ''], ['(?:ab|a)c', ''],
  ['[a-c]+', ''], ['[^a-c]', ''], ['^[A-Z][a-z]*$', 'i'], ['\\d+\\.\\d+', ''], ['^\\w+@\\w+\\.com$', ''],
  ['\\s', ''], ['\\S+', ''], ['\\bbug\\b', 'i'], ['\\Bug', ''], ['^$', ''], ['a|^b|c$', ''],
  ['[\\d-]+', ''], ['[-a]', ''], ['[a-]', ''], ['[]', ''], ['[^]', ''], ['[]]', ''], ['\\x41\\u0042', ''],
  ['a\\.b', ''], ['\\[x\\]', ''], ['\\{1\\}', ''], ['}', ''], ['^(a|ab)(c|bcd)(d*)$', ''], ['(a*)*b', ''],
  ['(a|)+$', ''], ['(a{0}){3}b', ''], ['(()){2}x', ''], ['a(|b)c', ''], ['((a)(b)){2}', ''], ['.', ''], ['^.$', ''], ['[\\b]', ''], ['a+?b', ''], ['^v\\d+\\.\\d+\\.\\d+(-rc\\.\\d+)?$', ''],
];
const SUBJECTS = [
  '', 'abc', 'ABC', 'xabcx', 'ac', 'abbbc', 'color', 'colour', 'aa', 'aaa', 'aaaa', 'y', 'foobarbaz', 'abc',
  'ac', 'd', 'Hello', 'hello world', '3.14', 'ana@timon.com', ' ', '\n', 'a bug here', 'debug', 'BUG!', 'b',
  'c', '1-2', '-', ']', 'AB', 'a.b', 'a-b', '[x]', '{1}', '}', 'abcd', 'abcdd', 'aab', 'a', '\r', ' ',
  '\b', 'aab', 'v1.2.3', 'v1.2.3-rc.4', 'v1.2', 'Crash on start',
];

/**
 * Cost is checked by counting the engine's own steps, never by timing it: a
 * timing measures the machine's load as much as the code (a ~50 ms match took
 * 1.9 s in a loaded suite, TODO #629), a step count does not move.
 */
const meter = (): StepMeter => ({ steps: 0 });
/** The Pike VM's bound: each position visits an instruction at most once. */
const linearBound = (re: SafeRegex, subject: string) => (subject.length + 2) * (3 * re.size + 1);

test('the subset agrees with V8 on every pattern × subject', () => {
  for (const [pattern, flags] of PATTERNS) {
    const native = new RegExp(pattern, flags);
    const safe = compileSafeRegex(pattern, flags);
    for (const subject of SUBJECTS) {
      assert.equal(safe.test(subject), native.test(subject), `/${pattern}/${flags} on ${JSON.stringify(subject)}`);
    }
  }
});

test('outside the subset: refused at compile time', () => {
  for (const pattern of ['(a)\\1', '(?=a)', '(?!a)', '(?<=a)b', '(?<n>a)', '\\p{L}', '\\cA', '\\q', 'a**', '*a', 'a{', 'a{2,1}', '(a', 'a)', '[b-a]', '[\\d-z]', 'a{1001}', '^*']) {
    assert.throws(() => compileSafeRegex(pattern), SafeRegexError, pattern);
  }
  assert.throws(() => compileSafeRegex('(a{1000}){1000}'), /too complex/);
  assert.ok(MAX_PROGRAM >= 1000);
});

test('compilation is bounded too: repetitions of nothing never expand', () => {
  // Each of these used to expand its empty body, without ever emitting an
  // instruction to hit the cap: the last one was 10^12 steps at save time.
  // `simplify` and the compile step budget are two independent bounds: the
  // count below is `simplify`'s, the budget would stop at 128 000.
  for (const pattern of [
    '((){1000}){1000}',
    '((((){1000}){1000}){1000}){1000}',
    '((((a{0}){1000}){1000}){1000}){1000}',
    '((((a?){0}){1000}){1000}){1000}x',
  ]) {
    const work = meter();
    const re = compileSafeRegex(pattern, '', work);
    assert.ok(work.steps <= 2, `${pattern}: ${work.steps} compile steps`);
    assert.ok(re.size <= 2, `${pattern}: size ${re.size}`);
    assert.equal(re.test('x'), true, pattern);
  }
  assert.equal(compileSafeRegex('((((a{0}){1000}){1000}){1000}){1000}x').test('y'), false);
  // An empty body still loops when unbounded; its copies cost nothing either.
  assert.equal(compileSafeRegex('((){1000,}){1000}').test(''), true);
  for (const pattern of ['(((){1000,}){1000}){1000}', '((((){0,1000}){1000}){1000}){1000}']) {
    const work = meter();
    assert.throws(() => compileSafeRegex(pattern, '', work), /too complex/, pattern);
    assert.ok(work.steps <= 2, `${pattern}: ${work.steps} compile steps`);
  }
  // Deep grouping costs no compile step per level.
  const deep = `${'('.repeat(100)}a${')'.repeat(100)}{1000}`;
  assert.equal(compileSafeRegex(deep).size, 1001);
});

test('catastrophic patterns run in linear time on a hostile subject', () => {
  // Safe to run: this is the linear engine, never V8's backtracking one.
  // Within the subject cap, so the trailing '!' is really seen.
  const hostile = `${'a'.repeat(REGEX_SUBJECT_MAX - 1)}!`;
  for (const pattern of ['^(a|aa)+$', '(a+)+$', '^(a*)*$', '(.*a){20}$', '^(\\w+\\s?)*$', '^(a?){600}a{600}$']) {
    const filter = filterSchema.parse({ op: 'regex', path: 'v', pattern });
    assert.equal(evaluateFilter(filter, { body: { v: hostile }, headers: {} }), false, pattern);
    // The same program, metered: every position was walked, none twice per instruction.
    const re = compileSafeRegex(pattern);
    const work = meter();
    assert.equal(re.test(hostile, work), false, pattern);
    assert.ok(work.steps >= hostile.length, `${pattern}: the meter saw only ${work.steps} steps`);
    assert.ok(work.steps <= linearBound(re, hostile), `${pattern}: ${work.steps} steps > ${linearBound(re, hostile)}`);
  }
});

/** The engine's own worst case: a wide class (match in its last range), the
 *  most live threads a program allows, every position, every leaf. */
function worstClass(): string {
  let cls = '';
  for (let c = 0x100; cls.length < 160; c += 2) cls += String.fromCharCode(c);
  return `[${cls}a!]`;
}

test('a filter is budgeted as a whole: many heavy leaves are refused, the heaviest allowed one stays fast', () => {
  const heavy = (n: number) => ({ op: 'regex', path: 'v', pattern: `${worstClass()}{0,${n}}$`, flags: 'i' });
  // Each leaf alone fits the per-pattern cap; together they exceed the filter budget.
  assert.throws(() => filterSchema.parse({ all: Array.from({ length: 32 }, () => heavy(100)) }), /too complex together/);
  const one = compileSafeRegex(heavy(990).pattern, 'i');
  assert.ok(one.size <= REGEX_FILTER_BUDGET);
  const filter = filterSchema.parse({ all: [heavy(990)] });
  const subject = `${'a'.repeat(REGEX_SUBJECT_MAX - 1)}!`;
  assert.equal(evaluateFilter(filter, { body: { v: subject }, headers: {} }), true);
  // What a filter may cost at all: the subject cap times the program budget.
  const work = meter();
  assert.equal(one.test(subject, work), true);
  assert.ok(work.steps >= subject.length, `the meter saw only ${work.steps} steps`);
  assert.ok(work.steps <= linearBound(one, subject), `${work.steps} steps > ${linearBound(one, subject)}`);
  assert.ok(linearBound(one, subject) <= (REGEX_SUBJECT_MAX + 2) * (3 * REGEX_FILTER_BUDGET + 1));
});
