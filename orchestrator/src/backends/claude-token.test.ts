import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dbApi } from '../db.js';
import { ROOKS_HOME } from '../paths.js';
import { claudeTokenMarkerPath } from '../host/service-install.js';
import { resolveMasterKey } from '../secrets/key.js';
import { rekeyVault } from '../secrets/store.js';
import { redactText } from '../secrets/redact.js';
import {
  CLAUDE_TOKEN_ENV, CLAUDE_TOKEN_KEY, CLAUDE_TOKEN_STORE, ClaudeTokenError, MISSING_TOKEN_MESSAGE,
  claudeSpawnEnv, claudeTokenStatus, clearClaudeToken, normalizeClaudeToken, readClaudeToken,
  runsOutsideGuiSession, setClaudeToken,
} from '../../tests/helpers/claude-provider.js';
import { ProfileEnvError } from './credentials.js';

resolveMasterKey({ keyring: null });
const TOKEN = 'sk-ant-oat01-TEST-ONLY-abcdefghijklmnopqrstuvwxyz0123456789';

test('the token is sealed at rest, readable back, and marked for the service installer', () => {
  setClaudeToken(`  ${TOKEN}\n`);
  const stored = dbApi.pluginKvGet(CLAUDE_TOKEN_STORE, CLAUDE_TOKEN_KEY)!;
  assert.ok(stored.startsWith('enc:1:'));
  assert.ok(!stored.includes(TOKEN));
  assert.equal(readClaudeToken(), TOKEN);
  assert.deepEqual(claudeTokenStatus(), { configured: true, readable: true });
  assert.ok(existsSync(claudeTokenMarkerPath(ROOKS_HOME)));
  assert.equal(clearClaudeToken(), true);
  assert.equal(readClaudeToken(), null);
  assert.deepEqual(claudeTokenStatus(), { configured: false, readable: false });
  assert.ok(!existsSync(claudeTokenMarkerPath(ROOKS_HOME)));
  assert.equal(clearClaudeToken(), false);
});

test('a malformed paste is refused without echoing it', () => {
  for (const bad of ['', 'short', `${TOKEN} ${TOKEN}`, `${TOKEN}\n${TOKEN}`, 42]) {
    assert.throws(() => normalizeClaudeToken(bad), (e: unknown) => e instanceof ClaudeTokenError
      && e.code === 'invalid' && !e.message.includes(String(bad).slice(0, 20) || '\0'));
  }
});

test('the token survives a vault key rotation', () => {
  setClaudeToken(TOKEN);
  rekeyVault();
  assert.equal(readClaudeToken(), TOKEN);
  clearClaudeToken();
});

test('the token is redacted from anything Rooks writes', () => {
  setClaudeToken(TOKEN);
  assert.ok(!redactText(`leaked ${TOKEN} here`).includes(TOKEN));
  clearClaudeToken();
  assert.ok(redactText(`leaked ${TOKEN} here`).includes(TOKEN));
});

test('claude spawns get the token only on the first-party profile', () => {
  assert.deepEqual(claudeSpawnEnv({}, () => TOKEN, false), { [CLAUDE_TOKEN_ENV]: TOKEN });
  // No token: exactly as before, the CLI keeps its own login.
  assert.equal(claudeSpawnEnv({}, () => null, false), undefined);
  // A redirected profile never receives the Anthropic token.
  const kimi = { ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: 'k' };
  assert.deepEqual(claudeSpawnEnv(kimi, () => TOKEN, true), kimi);
});

test('a LaunchDaemon without a token refuses the spawn with a clear reason', () => {
  assert.throws(() => claudeSpawnEnv({}, () => null, true),
    (e: unknown) => e instanceof Error && e.message.includes(MISSING_TOKEN_MESSAGE));
  assert.equal(runsOutsideGuiSession({ ROOKS_SERVICE_KIND: 'launchd-system' }), true);
  assert.equal(runsOutsideGuiSession({}), false);
});
