/**
 * TIM-0062: on Windows, a codex agent's per-mission config.toml must carry
 * `[windows] sandbox = "unelevated"`. Without that table codex resolves its
 * Windows sandbox to "disabled" and refuses every shell command of a
 * `read-only` or `workspace-write` turn ("blocked by policy"). `elevated` is
 * ruled out: it would re-provision the machine-wide sandbox accounts for every
 * fresh CODEX_HOME, hence every mission (a UAC prompt nobody answers).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/* Throwaway TIMON_HOME, set BEFORE any import: paths.js reads it at load time. */
const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-codex-winsandbox-'));
process.env.TIMON_HOME = TMP_HOME;
process.env.CODEX_AUTH_DIR = join(TMP_HOME, 'codex-auth');
mkdirSync(process.env.CODEX_AUTH_DIR, { recursive: true });
writeFileSync(join(process.env.CODEX_AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { windowsSandboxToml } = await import('../../official-providers/provider-codex/lib/codex.js');
const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
type AgentConfig = import('../agent.js').AgentConfig;

test('win32: [windows] table in unelevated mode', () => {
  const block = windowsSandboxToml('win32');
  const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  assert.deepEqual(lines, ['[windows]', 'sandbox = "unelevated"']);
});

test('off Windows: no [windows] table', () => {
  assert.equal(windowsSandboxToml('linux'), '');
  assert.equal(windowsSandboxToml('darwin'), '');
});

test('the materialised config.toml follows the platform, whatever the mode', async () => {
  for (const permission_mode of ['plan', 'auto']) {
    const cfg: AgentConfig = { cwd: TMP_HOME, model: 'gpt-5.5', permission_mode };
    const sp = await buildUnderSeal('codex', {
      agentName: 'TIMON.winsandbox',
      systemPrompt: 'Test agent.',
      message: 'Hello.',
      resumeSession: null,
      cfg,
      missionId: `mission-winsandbox-${permission_mode}`,
    });
    const codexHome = sp.env?.CODEX_HOME;
    assert.ok(typeof codexHome === 'string' && codexHome.length > 0, 'CODEX_HOME missing from the spawn');
    const configToml = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    const hasTable = /^\[windows\]$/m.test(configToml);
    assert.equal(hasTable, process.platform === 'win32', `unexpected [windows] table (${permission_mode}):\n${configToml}`);
    // A root key written after the table would belong to it: the table comes
    // after the provider's root keys, before any other table.
    if (hasTable) assert.match(configToml, /^\[windows\]\nsandbox = "unelevated"$/m);
  }
});
