/**
 * TODO #52 — `claude` runs on the account's own sign-in, and on nothing that could stand in for it.
 * (codex's half lives with its provider: `official-providers/codex-accounts.test.ts`.)
 */
import '../test-home.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { buildDialectUnderSeal } from '../../tests/helpers/official-providers.js';
import { claudeDialect } from '../../tests/helpers/claude-provider.js';
import { CLAUDE_TOKEN_ENV } from '../../tests/helpers/claude-provider.js';
import { isUsageNotSignedInError } from './usage-error.js';
import { getHost } from '../host/index.js';
import { ROOKS_HOME } from '../paths.js';
import { config } from '../config/load.js';
import type { ProfileRuntime } from './types.js';

function account(): NonNullable<ProfileRuntime['account']> {
  return { id: randomUUID().replace(/-/g, '').slice(0, 10), name: 'Pro', configDir: join(ROOKS_HOME, 'accounts-test', randomUUID()) };
}

const opts = (missionId = randomUUID()) => ({ agentName: 'acct', missionId,
  cfg: { cwd: ROOKS_HOME, browser_profile_id: null }, systemPrompt: 'Test', message: 'Test', resumeSession: null });

function isolate(t: TestContext) {
  const before = { ...process.env };
  const inherit = config().secrets.inheritEnv;
  t.after(() => { config().secrets.inheritEnv = inherit; process.env = before; });
  t.mock.method(getHost(), 'execAsync', () => { throw new Error('unexpected CLI check'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network'); });
}

test('claude: an account spawns on its config dir, with every other credential blanked', async (t) => {
  isolate(t);
  const acct = account();
  const spec = await buildDialectUnderSeal('claude', 'claude', { id: 'claude', cmd: 'claude', env: {}, account: acct }, opts());
  assert.equal(spec.env?.CLAUDE_CONFIG_DIR, acct.configDir);
  assert.equal(spec.env?.[CLAUDE_TOKEN_ENV], '');
  assert.equal(spec.env?.ANTHROPIC_API_KEY, '');
  if (process.platform !== 'win32') assert.equal(lstatSync(acct.configDir).mode & 0o777, 0o700);
});

test('claude measures an account on its own directory, never the host\'s sign-in (TODO #330)', async (t) => {
  isolate(t);
  // A host sign-in is there; the account directory is empty.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'host-token';
  const acct = account();
  const claude = claudeDialect.accountUsage!({ id: 'claude', cmd: 'claude', env: {}, account: acct });
  // macOS keeps an account's sign-in in a keychain entry Rooks does not read.
  if (process.platform === 'darwin') assert.equal(await claude, null);
  else await assert.rejects(claude, (error) => isUsageNotSignedInError(error));
});
