/**
 * SECURITY — `ctx.host.exec` runs with the system whitelist, not with the daemon's
 * environment (`docs/SECURITY.md` § 6.4.1). Until the provider work it inherited
 * everything: the vault's values, the mission token of the daemon, the daemon's
 * own credentials. The refusal is what is proved, with `secrets.inheritEnv` ON.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

const { config, setConfig } = await import('../config/load.js');
const { daemonHost } = await import('./context.js');

const WITNESSES: Record<string, string> = {
  TIMON_API_TOKEN: 'daemon-token-witness',
  TIMON_TELEGRAM_BOT_TOKEN: 'telegram-witness',
  TIMON_REMOTE_MASTER: 'master-witness',
  ACME_VAULT_API_KEY: 'vault-witness',
};

test('ctx.host.exec sees neither the vault, the token nor the daemon environment, even under inheritEnv', async (t) => {
  const previous = config();
  for (const [key, value] of Object.entries(WITNESSES)) process.env[key] = value;
  process.env.LC_FX_POINTER = 'kept';
  setConfig({ ...previous, secrets: { ...previous.secrets, inheritEnv: true } });
  t.after(() => {
    setConfig(previous);
    for (const key of Object.keys(WITNESSES)) delete process.env[key];
    delete process.env.LC_FX_POINTER;
  });

  // `process.execPath` bypasses the policy on purpose: this exercises the HOST binding, which
  // is where the environment is decided (the policy refuses `node` to a plugin before it).
  const result = await daemonHost(new Context()).exec(process.execPath, ['-p', 'JSON.stringify(process.env)'], {});
  assert.equal(result.code, 0, result.stderr);
  const seen = JSON.parse(result.stdout) as Record<string, string>;
  for (const key of Object.keys(WITNESSES)) assert.equal(seen[key], undefined, `${key} must not reach ctx.host.exec`);
  assert.equal(result.stdout.includes('witness'), false, 'no value of the daemon environment either');
  assert.equal(seen.LC_FX_POINTER, 'kept', 'the system whitelist still passes (locale family)');
  assert.ok(seen.PATH, 'PATH passes: the binary and what it starts must still be found');
});
