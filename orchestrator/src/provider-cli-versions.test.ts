/**
 * "Update available" on the provider cards: the installed version read from
 * the binary the daemon runs, the published one from the vendor's channel, and
 * nothing asked of the vendors once the check is off.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const { whichBin } = await import('./doctor.js');
const {
  beyondSupportedMajor, cliVersionInfo, compareVersions, fetchLatestVersion, installedBeyondSupportedMajor, npmLatestUrl,
  parseCliVersion, refreshCliVersions, resetCliVersionsForTests, updateCheckIntervalMs, versionCheckedClis,
} = await import('./provider-cli-versions.js');

const ON = () => true;
const OFF = () => false;

test('a version is read out of what each CLI prints', () => {
  assert.equal(parseCliVersion('2.1.310 (Claude Code)'), '2.1.310');
  assert.equal(parseCliVersion('codex-cli 0.159.0'), '0.159.0');
  assert.equal(parseCliVersion('grok 1.0.13 (5e9a58528b76) [stable]'), '1.0.13');
  assert.equal(parseCliVersion('GitHub Copilot CLI 1.0.105-beta.2.'), '1.0.105-beta.2');
  assert.equal(parseCliVersion('command not found'), null);
});

test('versions compare as releases, a prerelease below its release', () => {
  assert.equal(compareVersions('2.1.312', '2.1.310'), 1);
  assert.equal(compareVersions('0.165.0', '0.159.0'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
});

test('the registry is asked for a scoped package with its slash encoded', () => {
  assert.equal(npmLatestUrl('@anthropic-ai/claude-code'), 'https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest');
  assert.equal(npmLatestUrl('opencode-ai'), 'https://registry.npmjs.org/opencode-ai/latest');
});

test('only the providers that said where their releases are get checked, never an ACP adapter', () => {
  const names = versionCheckedClis().map((cli) => cli.name);
  // Pi is its own CLI since the RPC switch (`pi --version`); `hermes-acp` is an adapter that may start instead.
  assert.deepEqual(names, ['claude', 'codex', 'grok', 'copilot', 'opencode', 'pi']);
  assert.deepEqual(versionCheckedClis().find((cli) => cli.name === 'pi')?.latest, { npm: '@earendil-works/pi-coding-agent' });
});

test('the published version: a registry document or a plain-text endpoint, anything else is no version', async () => {
  const answer = (status: number, body: string) => async () => ({ ok: status < 400, status, text: async () => body });
  assert.equal(await fetchLatestVersion({ npm: '@openai/codex' }, answer(200, '{"name":"@openai/codex","version":"0.165.0"}')), '0.165.0');
  assert.equal(await fetchLatestVersion({ text: 'https://x.ai/cli/stable' }, answer(200, '1.0.70\n')), '1.0.70');
  assert.equal(await fetchLatestVersion({ text: 'https://x.ai/cli/stable' }, answer(200, '<html>maintenance</html>')), null);
  assert.equal(await fetchLatestVersion({ npm: 'x' }, answer(503, '')), null);
  assert.equal(await fetchLatestVersion({ npm: 'x' }, async () => { throw new Error('offline'); }), null);
});

test('an update is offered for the binary the daemon runs, and only for it', async () => {
  resetCliVersionsForTests();
  await refreshCliVersions(undefined, {
    locate: (name) => (name === 'claude' ? '/home/ann/.local/bin/claude' : null),
    readVersion: async () => '2.1.310',
    latest: async () => '2.1.312',
    enabled: ON,
  });
  assert.deepEqual(cliVersionInfo('claude', '/home/ann/.local/bin/claude', ON), { version: '2.1.310', latest: '2.1.312', updateAvailable: true, unsupportedVersion: false });
  // A second copy resolved instead (an npm install ahead on the PATH): its version was never read.
  assert.deepEqual(cliVersionInfo('claude', '/usr/lib/node_modules/.bin/claude', ON), { version: null, latest: '2.1.312', updateAvailable: false, unsupportedVersion: false });
  assert.equal(cliVersionInfo('codex', null, ON).version, null);
});

test('opencode 2 is another generation: no update offered over it, whatever the registry says', async () => {
  assert.equal(versionCheckedClis().find((cli) => cli.name === 'opencode')?.supportedMajor, 1);
  assert.equal(beyondSupportedMajor('2.0.0', 1), true);
  assert.equal(beyondSupportedMajor('2.0.0-beta.3', 1), true);
  assert.equal(beyondSupportedMajor('1.14.29', 1), false);
  assert.equal(beyondSupportedMajor(null, 1), false);
  assert.equal(beyondSupportedMajor('9.0.0', undefined), false);

  resetCliVersionsForTests();
  const path = '/home/ann/.opencode/bin/opencode';
  await refreshCliVersions(['opencode'], { locate: () => path, readVersion: async () => '2.0.1', latest: async () => '1.14.29', enabled: ON });
  assert.deepEqual(cliVersionInfo('opencode', path, ON), { version: '2.0.1', latest: '1.14.29', updateAvailable: false, unsupportedVersion: true });
  await refreshCliVersions(['opencode'], { locate: () => path, readVersion: async () => '1.3.0', latest: async () => '1.14.29', enabled: ON });
  assert.deepEqual(cliVersionInfo('opencode', path, ON), { version: '1.3.0', latest: '1.14.29', updateAvailable: true, unsupportedVersion: false });
  // A provider that declared no bound is never held back, and is not even asked for its version here.
  let asked = false;
  assert.equal(await installedBeyondSupportedMajor('claude', '/x/claude', async () => { asked = true; return '9.0.0'; }), false);
  assert.equal(asked, false);
  assert.equal(await installedBeyondSupportedMajor('opencode', path, async () => '2.0.0'), true);
});

test('the version is read at the path the daemon resolved, never under the bare name', async () => {
  resetCliVersionsForTests();
  const pinned = '/opt/tools/claude';
  const asked: string[] = [];
  await refreshCliVersions(['claude'], {
    locate: () => pinned,
    // The bare name would answer for another copy, older.
    readVersion: async (path) => { asked.push(path); return path === pinned ? '2.1.312' : '2.0.0'; },
    latest: async () => '2.1.312',
    enabled: ON,
  });
  assert.deepEqual(asked, [pinned]);
  assert.deepEqual(cliVersionInfo('claude', pinned, ON), { version: '2.1.312', latest: '2.1.312', updateAvailable: false, unsupportedVersion: false });
});

test('a pinned binary outside the PATH answers for itself, not the copy on the PATH', { skip: process.platform === 'win32' }, async () => {
  resetCliVersionsForTests();
  const root = mkdtempSync(join(tmpdir(), 'cli-version-'));
  const fake = (dir: string, version: string): string => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'claude');
    writeFileSync(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const onPath = fake(join(root, 'path'), '2.0.0');
  const pinned = fake(join(root, 'pinned'), '2.1.312');
  const before = process.env.PATH;
  process.env.PATH = `${join(root, 'path')}${delimiter}${before ?? ''}`;
  try {
    assert.equal(whichBin('claude').path, onPath);
    // The real host reads `--version`: only the locate step is the test's.
    await refreshCliVersions(['claude'], {
      locate: (name) => whichBin(name, { claude: pinned }).path,
      latest: async () => '2.1.312',
      enabled: ON,
    });
    assert.deepEqual(cliVersionInfo('claude', pinned, ON), { version: '2.1.312', latest: '2.1.312', updateAvailable: false, unsupportedVersion: false });
    assert.equal(cliVersionInfo('claude', onPath, ON).version, null);
  } finally {
    process.env.PATH = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test('off, the vendors are not asked and no update is shown; the installed version still is', async () => {
  resetCliVersionsForTests();
  let asked = 0;
  await refreshCliVersions(undefined, {
    locate: () => '/home/ann/.local/bin/codex',
    readVersion: async () => '0.159.0',
    latest: async () => { asked += 1; return '0.165.0'; },
    enabled: OFF,
  });
  assert.equal(asked, 0);
  assert.deepEqual(cliVersionInfo('codex', '/home/ann/.local/bin/codex', OFF), { version: '0.159.0', latest: null, updateAvailable: false, unsupportedVersion: false });
});

test('the interval is one hour at the least', () => {
  assert.equal(updateCheckIntervalMs(0), 3_600_000);
  assert.equal(updateCheckIntervalMs(12), 43_200_000);
  assert.equal(updateCheckIntervalMs(Number.NaN), 43_200_000);
});
