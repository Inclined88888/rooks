/**
 * Shared local-brain paths stay under ROOKS_HOME and match the terminal layout.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-shared-brain-'));

const { ROOKS_HOME, SKILLS_DIR, GLOBAL_MEMORY_DIR } = await import('./paths.js');
const { SHARED_BRAIN, sharedBrainPaths } = await import('./shared-brain.js');

test('shared brain paths live under ROOKS_HOME', () => {
  const p = sharedBrainPaths();
  assert.equal(p.home, ROOKS_HOME);
  assert.equal(p.skillsDir, SKILLS_DIR);
  assert.equal(p.memoryDir, GLOBAL_MEMORY_DIR);
  assert.equal(p.terminalMemory, join(ROOKS_HOME, 'config', 'terminal-memory.json'));
  assert.equal(p.appLink, join(ROOKS_HOME, 'run', 'app.json'));
  assert.equal(p.needsYouDir, join(ROOKS_HOME, 'run', 'needs-you'));
  assert.equal(p.secretsEnv, join(ROOKS_HOME, 'secrets.env'));
  assert.equal(p.appearance, join(ROOKS_HOME, 'appearance.json'));
});

test('SHARED_BRAIN relative keys are stable for the terminal mirror', () => {
  assert.equal(SHARED_BRAIN.terminalToml, 'config/rooks.toml');
  assert.equal(SHARED_BRAIN.terminalKeys, 'config/rooks-keys.json');
  assert.equal(SHARED_BRAIN.skillsDir, 'skills');
  assert.equal(SHARED_BRAIN.needsYouDir, 'run/needs-you');
});

test('sharedBrainPaths honours an alternate home (tests / portable)', () => {
  const alt = join(tmpdir(), 'rooks-alt-home');
  const p = sharedBrainPaths(alt);
  assert.equal(p.skillsDir, join(alt, 'skills'));
  assert.equal(p.terminalKeys, join(alt, 'config', 'rooks-keys.json'));
});
