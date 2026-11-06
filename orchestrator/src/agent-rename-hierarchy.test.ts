/**
 * Renaming an agent must carry the hierarchy with it: `reports_to` and the
 * `orchestrates` entries of the OTHER agents name it, and a delegation right
 * that dropped silently on rename would be a permission bug nobody sees.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { renameAgent } = await import('./agent.js');
await import('../tests/helpers/claude-provider.js');

const { agentDir } = await import('./paths.js');
const { listAgents } = await import('./agent.js');
const { mayDelegate } = await import('./agent-orchestration.js');

function seed(name: string, config: Record<string, unknown>): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'test');
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify(config, null, 2));
}
const cfg = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(agentDir(name), 'config.json'), 'utf8')) as Record<string, unknown>;
const roster = () => listAgents().map((a) => ({ name: a.name, reports_to: a.reports_to, orchestrator: a.orchestrator, orchestrates: a.orchestrates }));

test('renaming a chief keeps its derived subtree and every explicit list that named it', () => {
  seed('boss', {});
  seed('boss.report', { reports_to: 'boss' });
  seed('boss.other', { reports_to: 'BOSS' }); // hand-written casing still points at the agent
  seed('picker', { orchestrates: ['boss', 'nobody-known', 'Boss'] });
  seed('all', { orchestrates: '*' });
  seed('bystander', { reports_to: 'boss.report' });

  const before = mayDelegate('boss', 'boss.report', roster(), null);
  assert.equal(before, true);

  const r = renameAgent('boss', 'chief');
  assert.deepEqual(r, { ok: true });
  assert.equal(existsSync(agentDir('boss')), false);

  assert.equal(cfg('boss.report').reports_to, 'chief');
  assert.equal(cfg('boss.other').reports_to, 'chief');
  assert.deepEqual(cfg('picker').orchestrates, ['chief', 'nobody-known'], 'renamed, deduplicated, unknown names untouched');
  assert.equal(cfg('all').orchestrates, '*', "'*' is not a name");
  assert.equal(cfg('bystander').reports_to, 'boss.report', 'unrelated references are left alone');

  // The rights, not just the bytes: the renamed chief still orchestrates its people…
  assert.equal(mayDelegate('chief', 'boss.report', roster(), null), true);
  assert.equal(mayDelegate('chief', 'boss.other', roster(), null), true);
  assert.equal(mayDelegate('chief', 'bystander', roster(), null), true, 'transitive, through boss.report');
  // …and the explicit list still reaches it.
  assert.equal(mayDelegate('picker', 'chief', roster(), null), true);
  assert.equal(mayDelegate('picker', 'boss.report', roster(), null), false);
});

test('an unreadable config is reported, not guessed at, and does not block the rename', () => {
  seed('lead', {});
  mkdirSync(agentDir('broken'), { recursive: true });
  writeFileSync(join(agentDir('broken'), 'system-prompt.md'), 'test');
  writeFileSync(join(agentDir('broken'), 'config.json'), '{ not json');
  const r = renameAgent('lead', 'lead2');
  assert.equal(r.ok, true);
  assert.equal(existsSync(agentDir('lead2')), true);
  assert.ok(r.warnings?.some((w) => w.startsWith('broken:')), 'the unreadable agent is named');
  assert.equal(readFileSync(join(agentDir('broken'), 'config.json'), 'utf8'), '{ not json', 'never rewritten');
  rmSync(agentDir('broken'), { recursive: true, force: true });
});

test('a write failure undoes the earlier rewrites and leaves the old identity intact', (t) => {
  // Read-only bits are not enforced for root, nor reliably on Windows.
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('permissions not enforced here');
  seed('captain', {});
  seed('a-writable', { reports_to: 'captain' });
  seed('z-locked', { reports_to: 'captain' });
  const lockedFile = join(agentDir('z-locked'), 'config.json');
  const writableBefore = readFileSync(join(agentDir('a-writable'), 'config.json'), 'utf8');
  chmodSync(lockedFile, 0o444);
  try {
    const r = renameAgent('captain', 'admiral');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /z-locked/);
    assert.equal(existsSync(agentDir('captain')), true, 'not moved');
    assert.equal(existsSync(agentDir('admiral')), false);
    assert.equal(readFileSync(join(agentDir('a-writable'), 'config.json'), 'utf8'), writableBefore, 'earlier rewrite restored byte for byte');
    assert.equal(cfg('z-locked').reports_to, 'captain');
  } finally {
    chmodSync(lockedFile, 0o644);
    rmSync(agentDir('z-locked'), { recursive: true, force: true });
  }
  // With the obstacle gone the very same rename now succeeds.
  assert.deepEqual(renameAgent('captain', 'admiral'), { ok: true });
  assert.equal(cfg('a-writable').reports_to, 'admiral');
});
