/**
 * SECURITY — an agent installed from the ACP registry is THIRD-PARTY code
 * (`docs/SECURITY.md` § 6.4.1, `docs/PROVIDERS-SDK.md` § 12.6, 12.8).
 *
 * It is a provider of the registry's own (`acp-registry` holds its dialect,
 * never marked trusted), not the release's: `isProductBackend` is by registration,
 * so the mission token, the vault slice and the daemon environment stay out of its
 * process. The test goes through the REAL registration (`defaultRegister`) and the
 * real launch (`spawnAgent`) — a stub would prove nothing about what the service wires.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as nodeSpawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildTarGzWithModes } from './archive-fixtures.js';

await import('../../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const posix = process.platform !== 'win32';
const { AcpRegistryService, ACP_REGISTRY_OWNER, profileIdOf } = await import('./service.js');
const { REGISTRY_URL } = await import('./schema.js');
const { getHost } = await import('../../host/index.js');
const { spawnAgent, upsertAgent, missionEnv } = await import('../../agent.js');
const { ensureDaemonToken } = await import('../../plugins-bundled/http/auth.js');
const { config, setConfig } = await import('../../config/load.js');
const { dbApi } = await import('../../db.js');
const { seal } = await import('../../secrets/box.js');
const { resolveMasterKey } = await import('../../secrets/key.js');
const { isProductBackend, backendTrust, registeredBackendOwners, getDialect } = await import('../../backends/registry.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../../../tests/helpers/official-providers.js');
const { backendNames } = await import('../../backends/index.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4244;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit('exit', 0, signal ?? null);
    child.emit('close', 0, signal ?? null);
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

async function launch(agent: string): Promise<{ env: NodeJS.ProcessEnv; written: string; dispose: () => void }> {
  const host = getHost();
  const original = host.spawn;
  const children: FakeChild[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  host.spawn = ((_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild();
    children.push(child);
    envs.push((opts?.env ?? {}) as NodeJS.ProcessEnv);
    return child;
  }) as typeof host.spawn;
  try {
    await spawnAgent(agent, 'ping');
  } finally {
    host.spawn = original;
  }
  assert.equal(envs.length, 1, 'one spawn, via the host');
  const child = children[0]!;
  let written = '';
  child.stdin.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
  await new Promise((resolve) => setImmediate(resolve));
  return { env: envs[0]!, written, dispose: () => { if (!child.killed) child.kill(); } };
}

const archive = buildTarGzWithModes([
  { path: 'dist/', type: '5', mode: 0o755 },
  { path: 'dist/agent', data: '#!/bin/sh\nexit 0\n', mode: 0o755 },
]);
const ARCHIVE_URL = 'https://downloads.example.com/untrusted.tar.gz';
const AGENT_ID = 'untrusted-agent';
const registryDoc = Buffer.from(JSON.stringify({
  version: '1.0.0',
  agents: [{
    id: AGENT_ID, name: 'Untrusted Agent', version: '1.0.0',
    distribution: { binary: { 'linux-x86_64': {
      archive: ARCHIVE_URL, cmd: './dist/agent', args: ['acp'], sha256: createHash('sha256').update(archive).digest('hex'),
    } } },
  }],
}));
const served = new Map<string, Buffer>([[REGISTRY_URL, registryDoc], [ARCHIVE_URL, archive]]);

const service = new AcpRegistryService({
  home: mkdtempSync(join(tmpdir(), 'rooks-acp-untrusted-')),
  fetchFn: async (url) => {
    const hit = served.get(url);
    return hit ? new Response(new Uint8Array(hit), { status: 200 }) : new Response('nope', { status: 404 });
  },
  platform: 'linux',
  arch: 'x64',
});

createTestAccount(dbApi, { email: 'registry-witness@example.test', name: 'Witness', passwordHash: 'unused' });
const DAEMON_TOKEN = ensureDaemonToken();
const profileId = profileIdOf(AGENT_ID);
// The release's own ACP agents, for the contrast: opencode is official, the registry's agent is not.
await stubCliBinaries('opencode');
await mountOfficialProviders();
const PLANTED_VAULT = 'vault-value-registry-witness';

if (posix) {
  await service.install(AGENT_ID);
  upsertAgent({
    name: 'registry.agent',
    system_prompt: 'witness — does nothing.',
    config: { backend: profileId, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const key = resolveMasterKey({ keyring: null });
  const row = dbApi.createSecret({ name: 'VAULT_REGISTRY_WITNESS', value_enc: 'placeholder', mode: 'inject' });
  dbApi.updateSecret(row.id, { value_enc: seal(PLANTED_VAULT, key, { secretId: row.id, name: 'VAULT_REGISTRY_WITNESS' }) });
  dbApi.addSecretGrant(row.id, 'global');
}

test('a registry agent is registered for real, as a provider of its own that the product does NOT answer for', { skip: !posix }, () => {
  assert.ok(backendNames().includes(profileId), 'dispatchable');
  assert.equal(isProductBackend(profileId), false, 'third-party by construction: fails closed on every credential');
  assert.equal(backendTrust(profileId), 'third-party');
  const dialect = getDialect(profileId);
  assert.ok(dialect, 'the agent has its own dialect, under its own id');
  assert.notEqual(dialect, getDialect('opencode'), 'not the release\'s provider: a definition of its own');
  assert.equal(registeredBackendOwners().dialects[profileId], ACP_REGISTRY_OWNER);
  assert.equal(backendTrust('opencode'), 'official', 'contrast: the release\'s own agent is official');
  // The same protocol runtime, so the agent still speaks ACP.
  assert.equal(dialect.sessionStore, getDialect('opencode')!.sessionStore);
  assert.equal(typeof dialect.openSession, 'function');
  assert.equal(registeredBackendOwners().dialects['acp-registry'], undefined, 'no shared dialect: one provider per agent');
});

test('REFUSAL: no mission token, no vault slice, no daemon env reaches a registry agent\'s process', { skip: !posix }, async () => {
  const previous = config();
  process.env.DAEMON_ONLY_REGISTRY_WITNESS = 'daemon-env-witness';
  try {
    setConfig({ ...previous, secrets: { ...previous.secrets, inheritEnv: true } });
    const { env, written, dispose } = await launch('registry.agent');
    try {
      assert.equal(Object.keys(env).some((k) => k.toUpperCase() === 'ROOKS_API_TOKEN'), false, 'no token variable');
      assert.equal(env.VAULT_REGISTRY_WITNESS, undefined, 'no vault slice');
      assert.equal(env.DAEMON_ONLY_REGISTRY_WITNESS, undefined, 'inheritEnv hands nothing to a third party');
      const procEnv = JSON.stringify(env);
      assert.equal(procEnv.includes(DAEMON_TOKEN), false);
      assert.equal(procEnv.includes(PLANTED_VAULT), false);
      assert.equal(written.includes(DAEMON_TOKEN), false, 'the daemon-token is never on the pipe');
      assert.equal(env.ROOKS_MISSION_ID !== undefined && env.ROOKS_API !== undefined, true, 'identity pointers stay');
    } finally {
      dispose();
    }
  } finally {
    setConfig(previous);
    delete process.env.DAEMON_ONLY_REGISTRY_WITNESS;
  }
});

test('the session of a registry agent declares Rooks\'s MCP servers with the mission\'s token swapped on the pipe — never a reference, never the daemon token or the vault', { skip: !posix }, async () => {
  const host = getHost();
  const original = host.spawn;
  const FAKE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backends', 'acp', '__fixtures__', 'fake-acp-agent.mjs');
  let child: ReturnType<typeof nodeSpawn> | null = null;
  let piped = '';
  let processEnv: NodeJS.ProcessEnv = {};
  host.spawn = ((_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    processEnv = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    child = nodeSpawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr!.resume();
    const write = child.stdin!.write.bind(child.stdin!) as (chunk: unknown, ...rest: unknown[]) => boolean;
    child.stdin!.write = ((chunk: unknown, ...rest: unknown[]) => {
      piped += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      return write(chunk, ...rest);
    }) as typeof child.stdin.write;
    return child as never;
  }) as typeof host.spawn;
  try {
    await spawnAgent('registry.agent', 'ping');
    const deadline = Date.now() + 5000;
    while (!piped.includes('"session/new"') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    host.spawn = original;
  }
  try {
    const request = piped.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { method?: string; params?: { mcpServers?: Array<{ name: string; env: Array<{ name: string; value: string }> }> } })
      .find((message) => message.method === 'session/new');
    assert.ok(request, 'the session was opened');
    const servers = request.params?.mcpServers ?? [];
    for (const name of ['rooks', 'rooks_ask']) {
      const token = servers.find((server) => server.name === name)?.env.find((entry) => entry.name === 'ROOKS_API_TOKEN')?.value;
      assert.ok(token && !token.startsWith('rooks-seal-'), `${name} carries a real token, not a reference`);
      assert.notEqual(token, DAEMON_TOKEN, 'the mission\'s own token, never the daemon\'s');
    }
    assert.equal(piped.includes('rooks-seal-'), false, 'no reference reached the agent');
    assert.equal(piped.includes(DAEMON_TOKEN), false);
    assert.equal(piped.includes(PLANTED_VAULT), false, 'the vault slice is not part of the session');
    assert.equal(Object.keys(processEnv).some((k) => k.toUpperCase() === 'ROOKS_API_TOKEN'), false, 'the process itself holds no token');
  } finally {
    (child as { kill(signal: string): void } | null)?.kill('SIGKILL');
  }
});

test('contrast: a product backend launched the same way DOES get the token and the vault slice', { skip: !posix }, async () => {
  // Guards the refusals above against passing for the wrong reason (no grant, no token at all).
  upsertAgent({
    name: 'registry.claude',
    system_prompt: 'witness — does nothing.',
    config: { backend: 'claude', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const product = await launch('registry.claude');
  try {
    assert.ok(product.env.ROOKS_API_TOKEN, 'the product dialect keeps the mission token in its env');
    assert.equal(product.env.VAULT_REGISTRY_WITNESS, PLANTED_VAULT);
  } finally {
    product.dispose();
  }
  const untrusted = missionEnv({ missionId: 'm', agentName: 'a', cwd: tmpdir(), untrusted: true, specEnv: { nova_api_token: 'planted' } });
  assert.equal(JSON.stringify(untrusted).includes('planted'), false);
  assert.equal(Object.keys(untrusted).some((k) => k.toUpperCase() === 'ROOKS_API_TOKEN'), false);
});

test('dispose: the profile and the agent\'s dialect go with the service', { skip: !posix }, () => {
  service.dispose();
  assert.equal(backendNames().includes(profileId), false);
  assert.equal(getDialect(profileId), undefined, 'no dialect left behind');
});
