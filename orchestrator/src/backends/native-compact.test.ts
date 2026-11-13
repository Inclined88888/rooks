/**
 * Native compaction is DECLARED by a provider (`session.compact`), never read
 * off a backend's name: the official Claude and Grok providers declare it,
 * Codex does not (`codex exec resume` reads `/compact` as a prompt), and a
 * third party declares it the same way. A Grok compaction turn is the one
 * launch without `--verbatim`, or the CLI would hand `/compact` to the model.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOKS_HOME } from '../paths.js';
import { mountOfficialProviders, stubCliBinaries, buildUnderSeal } from '../../tests/helpers/official-providers.js';
import { nativeCompactCommand } from './capabilities.js';
import { catalogBackend } from './index.js';
import { definitionProblems } from './engine/definition-check.js';
import { dialectProblems } from './dialect-check.js';
import { dialectFromDefinition } from './engine/native.js';
import type { BuildSpawnOpts, NativeProviderDefinition } from './types.js';

process.env.CODEX_AUTH_DIR = join(ROOKS_HOME, 'codex-auth');
mkdirSync(process.env.CODEX_AUTH_DIR, { recursive: true });
writeFileSync(join(process.env.CODEX_AUTH_DIR, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

await stubCliBinaries('grok', 'copilot', 'opencode');
await mountOfficialProviders();

function opts(over: Partial<BuildSpawnOpts> = {}): BuildSpawnOpts {
  return {
    agentName: 'acme.main', systemPrompt: 'Test', message: '/compact', resumeSession: 'session-1',
    missionId: randomUUID(), cfg: { cwd: ROOKS_HOME }, ...over,
  };
}

test('claude and grok declare a native compaction, codex does not', () => {
  assert.equal(nativeCompactCommand('claude'), '/compact');
  assert.equal(nativeCompactCommand('grok'), '/compact');
  assert.equal(nativeCompactCommand('codex'), null);
  assert.equal(nativeCompactCommand('copilot'), null);
  assert.equal(nativeCompactCommand(null), null);
  assert.equal(nativeCompactCommand('no-such-backend'), null);
});

test('an account instance compacts like its backend', () => {
  assert.equal(nativeCompactCommand('claude@acct1'), '/compact');
  assert.equal(nativeCompactCommand('codex@acct1'), null);
});

test('the catalogue says which backends compact natively, and only when they do', () => {
  assert.equal(catalogBackend('claude')?.nativeCompact, true);
  assert.equal(catalogBackend('codex')?.nativeCompact, undefined);
});

test('grok: an ordinary turn keeps --verbatim, a compaction turn drops it', async () => {
  const plain = await buildUnderSeal('grok', opts({ message: '/etc/hosts is the file' }));
  assert.ok(plain.args.includes('--verbatim'));
  const command = await buildUnderSeal('grok', opts({ agentCommand: true }));
  assert.ok(!command.args.includes('--verbatim'));
  assert.ok(command.args.includes('-r'));
});

const MINIMAL = {
  id: 'acme-compact',
  transport: { kind: 'process-per-turn' },
  launch: async () => ({ cmd: 'acme', args: [], initialStdin: null }),
  codec: { kind: 'lines', parseLine: () => [], extractSessionId: () => null },
  session: { store: 'global', resumable: true },
  permission: { model: 'sandbox' },
  limits: { reporting: 'none' },
  mcp: { rooks: false },
  declares: { binary: { names: ['acme'] } },
};

test('a third-party definition declares compaction, and the adapter carries it to the dialect', () => {
  const def = { ...MINIMAL, session: { ...MINIMAL.session, compact: { command: '/compact' } } };
  assert.deepEqual(definitionProblems(def), []);
  const dialect = dialectFromDefinition(def as unknown as NativeProviderDefinition);
  assert.deepEqual(dialect.nativeCompact, { command: '/compact' });
  assert.equal(dialectFromDefinition(MINIMAL as unknown as NativeProviderDefinition).nativeCompact, undefined);
});

test('a malformed declaration is refused, in a definition and in a dialect', () => {
  for (const compact of [{}, { command: '' }, { command: 3 }, '/compact']) {
    const def = { ...MINIMAL, session: { ...MINIMAL.session, compact } };
    assert.ok(definitionProblems(def).some((p) => p.includes('session.compact')), JSON.stringify(compact));
  }
  assert.ok(dialectProblems({ nativeCompact: { command: ' ' } }).some((p) => p.includes('nativeCompact')));
});
