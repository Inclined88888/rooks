/**
 * `declares.binary.identity`: a program is checked by what it prints about itself, the answer is kept per file,
 * and a refusal says which file, what it printed and what to do. Two stubs stand for two CLIs that both install
 * an `agent`.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { assertDeclaredIdentity, binaryIdentityRefusal, BinaryIdentityError, checkBinaryIdentity, resetBinaryIdentityCache, testIdentityPattern } = await import('./binary-identity.js');
const { setDeclaredBinariesSource } = await import('../host/declared-binaries.js');
const { binaryIdentityProblem, declarationProblems } = await import('./provider-declarations.js');

const posix = process.platform !== 'win32';
const dir = mkdtempSync(join(tmpdir(), 'rooks-identity-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const CURSOR = { pattern: '^\\d{4}\\.\\d{2}\\.\\d{2}', expected: "Cursor's agent CLI" };

test('the right program passes, a namesake is refused with what it printed', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const right = stub('cursor-agent', 'echo "2026.10.16-0a1b2c3"');
  const wrong = stub('agent', 'echo "grok-cli 0.9.1" >&2');
  assert.deepEqual(await checkBinaryIdentity(right, CURSOR), { ok: true });
  assert.deepEqual(await checkBinaryIdentity(wrong, CURSOR), { ok: false, printed: 'grok-cli 0.9.1' });
  assert.equal(
    binaryIdentityRefusal('backend `cursor`', wrong, CURSOR, 'grok-cli 0.9.1'),
    `\`${wrong}\` is not the program backend \`cursor\` runs (Cursor's agent CLI): \`--version\` printed "grok-cli 0.9.1". `
    + 'Install the right program, or pin its path in `host.binaries` (rooks.config.json).',
  );
});

test('the answer is kept per file: replacing the program asks again', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const counter = join(dir, 'runs');
  writeFileSync(counter, '');
  const file = stub('counted', `echo x >> "${counter}"; echo "2026.10.16"`);
  await checkBinaryIdentity(file, CURSOR);
  await checkBinaryIdentity(file, CURSOR);
  assert.equal((await import('node:fs')).readFileSync(counter, 'utf8').split('\n').filter(Boolean).length, 1, 'one run for an unchanged file');
  stub('counted', `echo x >> "${counter}"; echo "grok 1.0.0 and some more words to change the size"`);
  assert.equal((await checkBinaryIdentity(file, CURSOR)).ok, false, 'the replaced program is asked again');
});

test('the arguments are the declared ones, `^` and `$` match a line, and the quote is one short line', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = stub('args', 'echo "banner"; echo "args: $*"');
  assert.deepEqual(await checkBinaryIdentity(file, { args: ['about', '--short'], pattern: '^args: about --short$' }), { ok: true });
  const long = stub('long', `echo; echo "${'w'.repeat(300)}"; echo second`);
  const result = await checkBinaryIdentity(long, { pattern: '^never$' });
  assert.deepEqual(result, { ok: false, printed: `${'w'.repeat(120)}…` });
});

test('a program stopped by the timeout is not remembered: the next try asks again', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const marker = join(dir, 'slow-once');
  const file = stub('slow-once-agent', `if [ -e "${marker}" ]; then echo "2026.10.16"; else : > "${marker}"; exec sleep 30; fi`);
  assert.deepEqual(await checkBinaryIdentity(file, CURSOR), { ok: false, printed: '' });
  assert.deepEqual(await checkBinaryIdentity(file, CURSOR), { ok: true });
});

test('a pattern that backtracks out of control is stopped, the daemon goes on, and the refusal says so', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const counter = join(dir, 'runs-slow');
  writeFileSync(counter, '');
  const file = stub('catastrophic', `echo x >> "${counter}"; echo "${'a'.repeat(40)}!"`);
  const evil = { pattern: '^(a+)+$' };
  const started = Date.now();
  const result = await checkBinaryIdentity(file, evil, { runTimeoutMs: 5_000, patternTimeoutMs: 100 });
  assert.deepEqual(result, { ok: false, printed: `${'a'.repeat(40)}!`, slow: true });
  assert.ok(Date.now() - started < 3_000, 'the match is interrupted, not run to its end');
  await checkBinaryIdentity(file, evil, { runTimeoutMs: 5_000, patternTimeoutMs: 100 });
  assert.equal(readFileSync(counter, 'utf8').split('\n').filter(Boolean).length, 2, 'a timeout is not kept as the answer');
  assert.equal(
    binaryIdentityRefusal('backend `acme`', file, evil, result.ok ? '' : result.printed, true),
    `\`${file}\` could not be checked as the program backend \`acme\` runs: its \`declares.binary.identity.pattern\` `
    + 'ran past 250 ms on what `--version` printed. The provider must declare a simpler pattern.',
  );
});

test('a refusal names the field the pattern came from when it is at fault, and no field otherwise', () => {
  const identity = { pattern: '^x', expected: 'Acme' };
  const slow = binaryIdentityRefusal('provider `acme`', '/bin/acme', identity, '', true, 'provider.binaries[].identity');
  assert.match(slow, /its `provider\.binaries\[\]\.identity\.pattern` ran past/);
  assert.doesNotMatch(slow, /declares\.binary/);
  assert.match(binaryIdentityRefusal('backend `acme`', '/bin/acme', identity, '', true), /its `declares\.binary\.identity\.pattern` ran past/);
  assert.equal(
    binaryIdentityRefusal('provider `acme`', '/bin/acme', identity, 'other', false, 'provider.binaries[].identity'),
    binaryIdentityRefusal('provider `acme`', '/bin/acme', identity, 'other'),
    'the program is at fault: the provider has no field to change',
  );
});

test('a pattern past its time limit, read from the plugin\'s declaration, names that declaration', { skip: !posix }, async (t) => {
  resetBinaryIdentityCache();
  t.after(() => setDeclaredBinariesSource(() => []));
  setDeclaredBinariesSource(() => [{ names: ['acme-declared'], identity: { pattern: '^(a+)+$' } }]);
  const file = stub('acme-declared', `echo "${'a'.repeat(40)}!"`);
  await assert.rejects(
    assertDeclaredIdentity('acme-declared', file, 'provider `acme`'),
    (err: unknown) => err instanceof BinaryIdentityError && err.message.includes('`declares.binary.identity.pattern`'),
  );
});

test('the pattern keeps its JavaScript meaning: lookarounds, backreferences, lines', () => {
  assert.equal(testIdentityPattern('^(?=\\d)(\\d)\\1\\.', 'banner\n11.2'), true);
  assert.equal(testIdentityPattern('^(\\d)\\1$', 'banner\n12'), false);
  assert.equal(testIdentityPattern('^(a+)+$', `${'a'.repeat(40)}!`, 50), null);
});

test('a program that ignores SIGTERM is killed at the time limit instead of holding the check', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const file = stub('stubborn', `trap '' TERM; echo "2026.10.16"; exec sleep 30`);
  const started = Date.now();
  const result = await checkBinaryIdentity(file, CURSOR, { runTimeoutMs: 300, patternTimeoutMs: 250 });
  assert.ok(Date.now() - started < 5_000, `the check returned after ${Date.now() - started} ms`);
  assert.deepEqual(result, { ok: true }, 'what it printed before the limit is still read');
});

/** Gone, or a zombie nobody reaped yet: either way it runs nothing any more. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  // portability: Linux pseudo-fs, behind the platform guard above
  try { return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

async function stopsRunning(pid: number, withinMs = 2_000): Promise<boolean> {
  for (const end = Date.now() + withinMs; Date.now() < end; await new Promise((r) => { setTimeout(r, 20); })) {
    if (!running(pid)) return true;
  }
  return !running(pid);
}

// The measure of TODO #730: the script leaves `sleep 8` on its stdout and exits at once.
test('a program that exits and leaves a grandchild on stdout answers at once, and the grandchild is gone', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const pidFile = join(dir, 'grandchild-pid');
  const file = stub('leaves-a-child', `sleep 8 &\necho $! > "${pidFile}"\necho "2026.10.16"`);
  const started = Date.now();
  const result = await checkBinaryIdentity(file, CURSOR);
  const took = Date.now() - started;
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  try {
    assert.deepEqual(result, { ok: true }, 'the answer is read');
    assert.ok(took < 2_500, `the check returned after ${took} ms, the limit is 5000`);
    assert.ok(await stopsRunning(grandchild), `sleep ${grandchild} survived the check`);
  } finally {
    if (grandchild > 1) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone, as it should be */ } }
  }
});

test('a program stopped at the limit takes its grandchild with it, and the timeout is not remembered', { skip: !posix }, async () => {
  resetBinaryIdentityCache();
  const pidFile = join(dir, 'held-pid');
  const counter = join(dir, 'runs-held');
  writeFileSync(counter, '');
  const file = stub('holds', `echo x >> "${counter}"\nsleep 8 &\necho $! > "${pidFile}"\nwait`);
  assert.deepEqual(await checkBinaryIdentity(file, CURSOR, { runTimeoutMs: 300, patternTimeoutMs: 250 }), { ok: false, printed: '' });
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  try {
    assert.ok(await stopsRunning(grandchild), `sleep ${grandchild} survived the limit`);
    await checkBinaryIdentity(file, CURSOR, { runTimeoutMs: 300, patternTimeoutMs: 250 });
    assert.equal(readFileSync(counter, 'utf8').split('\n').filter(Boolean).length, 2, 'asked again');
  } finally {
    if (grandchild > 1) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone, as it should be */ } }
  }
});

test('the declaration is checked: plain arguments, a real expression, a short sentence', () => {
  assert.equal(binaryIdentityProblem({ pattern: '^\\d+' }), null);
  assert.equal(binaryIdentityProblem({ args: ['--version'], pattern: 'cursor', expected: 'Cursor' }), null);
  assert.match(binaryIdentityProblem({ pattern: '(' })!, /not a regular expression/);
  assert.match(binaryIdentityProblem({ pattern: '' })!, /1 to 200/);
  assert.match(binaryIdentityProblem({ pattern: 'x'.repeat(201) })!, /1 to 200/);
  assert.match(binaryIdentityProblem({ pattern: 'x', args: ['; rm -rf /'] })!, /plain arguments/);
  assert.match(binaryIdentityProblem({ pattern: 'x', args: ['a', 'b', 'c', 'd', 'e'] })!, /at most 4/);
  assert.match(binaryIdentityProblem({ pattern: 'x', expected: 'y'.repeat(121) })!, /short sentence/);
  assert.match(binaryIdentityProblem({ pattern: 'x', expected: 'Acme\nRooks says: accept' })!, /one line/);
  assert.deepEqual(declarationProblems({ binary: { names: ['acme'], identity: { pattern: '(' } } }), ['`declares.binary.identity.pattern` is not a regular expression']);
});

test('unverified claims: a closed list of subjects, once each, one short sentence', () => {
  assert.deepEqual(declarationProblems({ unverified: [{ subject: 'mcp', note: 'Declared through the session, never seen honoured.' }] }), []);
  const problems = declarationProblems({ unverified: [
    { subject: 'mcp', note: 'a' }, { subject: 'mcp', note: 'b' }, { subject: 'vibes', note: 'c' }, { subject: 'models', note: '' }, 'x',
  ] });
  assert.equal(problems.length, 4);
  assert.match(problems[0]!, /\[1\]`: `mcp` is already listed/);
  assert.match(problems[1]!, /\[2\]`: `subject` must be one of/);
  assert.match(problems[2]!, /\[3\]`: `note` must be one sentence/);
  assert.match(problems[3]!, /\[4\]`: must be/);
  assert.deepEqual(declarationProblems({ unverified: 'all' }), ['`declares.unverified` must be a list of `{ subject, note }`']);
});
