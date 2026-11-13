/**
 * `host.keyring` capability (S.2, `docs/SECRETS-VAULT.md` §4.3).
 *
 * The AMBIENT keyring is deliberately never used: a case that relied on it would
 * pass on a desktop with an unlocked gnome-keyring and mean nothing about a VPS,
 * and vice versa. So the binding is driven through stand-in binaries — `/bin/false`
 * for a locked collection, and a witness script that speaks the `secret-tool`
 * protocol for a working one. What must hold everywhere: the capability appears
 * only when a real probe succeeds, and its absence never disturbs the boot.
 */
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-keyring-test-'));
// A bus address is the free gate before the probe; without it no test would
// ever reach the `secret-tool` call it means to exercise.
process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/rooks-test-bus';

const { RooksConfigSchema } = await import('../config/schema.js');
const { createGenericHost } = await import('./generic.js');
const { createLinuxHost } = await import('./linux.js');

/** Docker disabled everywhere here: its probe costs seconds and proves nothing. */
const cfg = (over: Record<string, unknown> = {}) => RooksConfigSchema.parse({
  host: { docker: 'disabled', ...(over.host as object ?? {}) },
  ...over,
});

test('generic does not expose the keyring capability', () => {
  const host = createGenericHost(cfg());
  assert.equal(host.keyring, undefined);
  assert.equal(host.capabilities().includes('keyring'), false);
});

test('a failing probe does not break the boot and leaves the capability absent', () => {
  // `/bin/false` is executable and always exits 1: the binary is there, the
  // probe fails — exactly what a locked collection looks like.
  const host = createLinuxHost(cfg({ host: { binaries: { 'secret-tool': '/bin/false' } } }));
  assert.equal(host.keyring, undefined);
  assert.equal(host.capabilities().includes('keyring'), false);
});

test('a missing secret-tool does not break the boot', () => {
  const host = createLinuxHost(cfg({ host: { binaries: { 'secret-tool': '/nonexistent/secret-tool' } } }));
  assert.equal(host.keyring, undefined);
});

test("secrets.keyring: 'off' does not even run the probe", () => {
  // The binary would succeed; only the setting rules the keyring out.
  const host = createLinuxHost(cfg({
    host: { binaries: { 'secret-tool': '/bin/true' } },
    secrets: { keyring: 'off' },
  }));
  assert.equal(host.keyring, undefined);
  assert.equal(host.capabilities().includes('keyring'), false);
});

test("secrets.keyring defaults to 'auto'", () => {
  assert.equal(RooksConfigSchema.parse({}).secrets.keyring, 'auto');
});

/**
 * A stand-in `secret-tool`: the only way to exercise the real binding without
 * depending on the machine running the suite having an unlocked gnome-keyring.
 *
 * Its `lookup` deliberately terminates the secret with a newline — that is the
 * detail the probe used to trip on. Storing `abc` and reading back `abc\n`
 * makes the read-back comparison fail, so the capability silently never
 * appeared on a host where the keyring worked perfectly.
 *
 * `brokenClear` keeps store and lookup working but makes `clear` fail, while
 * still recording that it was called (`clear-attempted` in the state dir).
 * Returns the state dir alongside the script so a case can inspect both.
 */
function witnessSecretTool(opts: { brokenClear?: boolean } = {}): { script: string; state: string } {
  const state = mkdtempSync(join(tmpdir(), 'rooks-keyring-witness-'));
  const script = join(state, 'secret-tool');
  writeFileSync(script, [
    '#!/bin/sh',
    `state='${state}'`,
    'cmd="$1"; shift',
    // Every call leaves a trace: a probe stores then clears, so the entries
    // alone cannot say whether the binary ever ran.
    'echo "$cmd" >> "$state/calls"',
    '# Scan for the `account <name>` pair; --label=… and the service pair are ignored.',
    'account=""',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "account" ]; then account="$2"; shift 2; else shift; fi',
    'done',
    'f="$state/$account"',
    'case "$cmd" in',
    '  store) cat > "$f" ;;',
    // An absent entry must exit non-zero and say NOTHING: anything on stderr is
    // read as a real failure, and would throw instead of answering `undefined`.
    '  lookup) [ -f "$f" ] || exit 1; printf "%s\\n" "$(cat "$f")" ;;',
    opts.brokenClear
      // Record the attempt, then refuse: the entry survives, which is precisely
      // the keyring `key.ts` could not purge.
      ? '  clear) : > "$state/clear-attempted"; echo "clear refused" >&2; exit 1 ;;'
      : '  clear) rm -f "$f" ;;',
    '  *) exit 2 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });
  chmodSync(script, 0o755);
  return { script, state };
}

test('a working secret-tool exposes host.keyring and the capability', () => {
  const host = createLinuxHost(cfg({ host: { binaries: { 'secret-tool': witnessSecretTool().script } } }));
  assert.ok(host.keyring, 'the probe should have succeeded against the witness secret-tool');
  assert.equal(host.capabilities().includes('keyring'), true);

  // The probe cleans up after itself: no witness entry survives it.
  assert.equal(host.keyring.get('rooks-test-account'), undefined);

  // The point of the case: `lookup` gives back `abc\n`, `get` must give `abc`.
  // Without the normalization the master key read back from the keyring would
  // never match the one just written.
  host.keyring.set('rooks-test-account', 'abc');
  assert.equal(host.keyring.get('rooks-test-account'), 'abc');
  host.keyring.del('rooks-test-account');
  assert.equal(host.keyring.get('rooks-test-account'), undefined);
});

test('a keyring whose clear fails is never exposed', () => {
  // Store and lookup both work: without making deletion part of the verdict the
  // probe would pass here. It must not — `key.ts` purges the keyring before any
  // file fallback, and a keyring that cannot delete turns a fresh install into a
  // daemon refusing to boot on `keyring-unavailable`.
  const witness = witnessSecretTool({ brokenClear: true });
  const host = createLinuxHost(cfg({ host: { binaries: { 'secret-tool': witness.script } } }));

  assert.equal(host.keyring, undefined, 'a keyring that cannot clear must stay hidden');
  assert.equal(host.capabilities().includes('keyring'), false);
  // The boot went through: the rest of the host is intact.
  assert.ok(host.capabilities().length > 0);

  // And the failure is the one meant: the probe did try to remove its witness.
  assert.equal(existsSync(join(witness.state, 'clear-attempted')), true,
    'the probe must attempt the deletion, not skip it');
});

test('under the test runner, a secret-tool found on PATH is never probed (TODO #574)', () => {
  // The machine running the suite may have a working Secret Service: the
  // witness on PATH stands in for it. Probing it would put the suite's master
  // key in the user's real `rooks` / `master-key` entry, the installed daemon's.
  const witness = witnessSecretTool();
  const savedPath = process.env.PATH;
  process.env.PATH = `${witness.state}${delimiter}${savedPath ?? ''}`;
  try {
    const host = createLinuxHost(cfg());
    assert.equal(host.keyring, undefined, 'the ambient keyring must stay out of reach of tests');
    assert.equal(host.capabilities().includes('keyring'), false);
    // Not merely refused: never touched.
    assert.equal(existsSync(join(witness.state, 'calls')), false, 'the ambient secret-tool must never run');
    // The same witness, pinned, does answer: the refusal above is the guard, not a broken stand-in.
    assert.ok(createLinuxHost(cfg({ host: { binaries: { 'secret-tool': witness.script } } })).keyring);
    assert.equal(existsSync(join(witness.state, 'calls')), true);
  } finally {
    process.env.PATH = savedPath;
  }
});
