/**
 * The launch context a plugin's backend code receives (`BackendLaunchContext`):
 * for whom and for what its resolver and its session are called, so it can pick
 * the connection of the account that launched the mission.
 *
 * Protected: a resolver written before the context existed works unchanged; a
 * mission gets its owner exactly as the daemon recorded it (an account, nobody
 * for a Kanban task, `plugin:<id>` for a plugin); the registry's own checks say
 * explicitly that no mission is behind them; and one account's missing
 * connection does not take the backend away from everyone else.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { dbApi } from '../db.js';
import { inactiveProfiles, recheckCredentials, registerDialect, registerProfile } from './registry.js';
import { getBackend, isBackendName, launchContextFor } from './index.js';
import type {
  BackendLaunchContext, BuildSpawnOpts, Dialect, RemoteDialect, RemoteSessionOpenArgs, SessionDriver, SessionOpenArgs,
} from './types.js';

const OWNER = 'launch-context-test';

const echoDialect: Dialect = {
  defaultCmd: 'echo',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: false,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(opts, profile) {
    return { cmd: profile.cmd, args: [], env: profile.env, cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput() { /* one-shot */ },
  parseLine: () => [],
  extractSessionId: () => null,
};
registerDialect(OWNER, 'launch-echo', echoDialect);

const opened: RemoteSessionOpenArgs[] = [];
const remoteDialect: RemoteDialect = {
  transport: 'remote',
  sessionResumable: false,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  extractSessionId: () => null,
  openSession(args): SessionDriver {
    opened.push(args);
    return {
      info: null,
      start: async () => ({ sessionId: 's', capabilities: { image: false, cancel: false, mcp: false }, resumed: false }),
      prompt: async () => ({ stopReason: 'end_turn' }),
      cancel: async () => {},
      close: () => {},
    } as unknown as SessionDriver;
  },
};
registerDialect(OWNER, 'launch-remote', remoteDialect);

const openedLocal: SessionOpenArgs[] = [];
registerDialect(OWNER, 'launch-session', {
  ...echoDialect,
  persistentProcess: true,
  finishMissionOnExit: true,
  openSession(args): SessionDriver {
    openedLocal.push(args);
    return {} as SessionDriver;
  },
});

const shape = { label: 'Launch', models: [], defaultModel: null } as const;

function spawnOpts(missionId: string, project: string | null = 'acme'): BuildSpawnOpts {
  return {
    agentName: 'acme.coder',
    systemPrompt: '',
    message: 'hi',
    resumeSession: null,
    cfg: { cwd: process.cwd(), project },
    missionId,
  } as unknown as BuildSpawnOpts;
}

let seq = 0;
function mission(owner: string | null, source?: { channel: string }): string {
  const id = `launch-ctx-${++seq}`;
  dbApi.createMission(id, 'acme.coder', 'hello', source, owner);
  return id;
}

test('a resolver that takes no argument works unchanged', async () => {
  const off = registerProfile(OWNER, { ...shape, id: 'launch-old', dialect: 'launch-echo', env: () => ({ TOKEN: 'k' }) });
  try {
    assert.equal(isBackendName('launch-old'), true);
    const spec = await getBackend('launch-old').buildSpawn(spawnOpts(mission('user-1')));
    assert.equal(spec.env?.TOKEN, 'k');
  } finally {
    off();
  }
});

test('the registry asks with an explicit no-mission context', async () => {
  const seen: (BackendLaunchContext | undefined)[] = [];
  const off = registerProfile(OWNER, {
    ...shape, id: 'launch-probe', dialect: 'launch-echo', env: (launch) => { seen.push(launch); return {}; },
  });
  try {
    await recheckCredentials();
    assert.ok(seen.length >= 1);
    for (const launch of seen) {
      assert.deepEqual(launch, { kind: 'probe', missionId: null, ownerUserId: null, agentName: null, project: null });
      assert.ok(Object.isFrozen(launch));
    }
  } finally {
    off();
  }
});

test('a mission gets its owner as the daemon recorded it: account, Kanban task, plugin', async () => {
  const seen: BackendLaunchContext[] = [];
  const off = registerProfile(OWNER, {
    ...shape, id: 'launch-mission', dialect: 'launch-echo',
    env: (launch) => { if (launch?.kind === 'mission') seen.push(launch); return { TOKEN: 'k' }; },
  });
  try {
    const backend = getBackend('launch-mission');
    const byUser = mission('user-1');
    const byTask = mission(null, { channel: 'kanban' });
    const byPlugin = mission('plugin:acme', { channel: 'plugin:acme' });
    await backend.buildSpawn(spawnOpts(byUser));
    await backend.buildSpawn(spawnOpts(byTask, null));
    await backend.buildSpawn(spawnOpts(byPlugin));
    assert.deepEqual(seen, [
      { kind: 'mission', missionId: byUser, ownerUserId: 'user-1', agentName: 'acme.coder', project: 'acme' },
      { kind: 'mission', missionId: byTask, ownerUserId: null, agentName: 'acme.coder', project: null },
      { kind: 'mission', missionId: byPlugin, ownerUserId: 'plugin:acme', agentName: 'acme.coder', project: 'acme' },
    ]);
  } finally {
    off();
  }
});

test('a spawn with no mission row behind it (a daemon one-shot) is a probe, not a made-up mission', () => {
  assert.equal(launchContextFor(spawnOpts('summary-1a2b3c4d')).kind, 'probe');
});

test('the remote session receives the same context as its resolver, and no token', async () => {
  const seen: BackendLaunchContext[] = [];
  const off = registerProfile(OWNER, {
    ...shape, id: 'launch-remote', dialect: 'launch-remote',
    env: (launch) => { if (launch?.kind === 'mission') seen.push(launch); return { URL: 'https://gw.test' }; },
  });
  try {
    const id = mission('user-2');
    const backend = getBackend('launch-remote');
    const driver = backend.openRemoteSession!({
      spawn: spawnOpts(id),
      host: { emit: () => {}, requestPermission: async () => ({ allow: false }), end: () => {} },
    } as unknown as Parameters<NonNullable<typeof backend.openRemoteSession>>[0]);
    await driver.start();
    const args = opened.at(-1)!;
    const expected = { kind: 'mission', missionId: id, ownerUserId: 'user-2', agentName: 'acme.coder', project: 'acme' };
    assert.deepEqual(args.launch, expected);
    assert.deepEqual(seen, [expected]);
    assert.ok(!JSON.stringify(args.launch).includes('ROOKS_API_TOKEN'));
    driver.close();
  } finally {
    off();
  }
});

test("one account without a connection does not take the backend away from the others", async () => {
  const connected = new Set(['user-ok']);
  const off = registerProfile(OWNER, {
    ...shape, id: 'launch-per-user', dialect: 'launch-echo',
    env: (launch) => {
      if (launch?.kind !== 'mission') return {};
      if (!launch.ownerUserId || !connected.has(launch.ownerUserId)) throw new Error('no connection for this account');
      return { TOKEN: `for-${launch.ownerUserId}` };
    },
  });
  try {
    const backend = getBackend('launch-per-user');
    await assert.rejects(backend.buildSpawn(spawnOpts(mission('user-without'))), /credential resolver failed/);
    assert.equal(isBackendName('launch-per-user'), true, 'still offered to the other accounts');
    assert.equal(inactiveProfiles().some((p) => p.id === 'launch-per-user'), false);
    const spec = await backend.buildSpawn(spawnOpts(mission('user-ok')));
    assert.equal(spec.env?.TOKEN, 'for-user-ok');
  } finally {
    off();
  }
});

test('a mission failure the probe confirms still takes the profile out at once', async () => {
  let key: string | undefined = 'ok';
  const off = registerProfile(OWNER, {
    ...shape, id: 'launch-lost', dialect: 'launch-echo',
    env: () => { if (!key) throw new Error('gone'); return { TOKEN: key }; },
  });
  try {
    const backend = getBackend('launch-lost');
    key = undefined;
    await assert.rejects(backend.buildSpawn(spawnOpts(mission('user-1'))), /credential resolver failed/);
    assert.equal(isBackendName('launch-lost'), false);
  } finally {
    off();
  }
});

test('an async resolver: a mission failure holds the profile out until the probe answers', async () => {
  let release: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  let lost = false;
  const off = registerProfile(OWNER, {
    ...shape, id: 'launch-async', dialect: 'launch-echo',
    env: async (launch) => {
      if (launch?.kind === 'mission') {
        if (lost || launch.ownerUserId !== 'user-ok') throw new Error('no connection for this account');
        return { TOKEN: 'k' };
      }
      await gate;
      if (lost) throw new Error('gone');
      return {};
    },
  });
  try {
    await recheckCredentials();
    const backend = getBackend('launch-async');
    assert.equal(isBackendName('launch-async'), true);

    // One account fails while the probe has not answered yet: the next mission
    // must not be sent there in the meantime.
    gate = new Promise((resolve) => { release = resolve; });
    await assert.rejects(backend.buildSpawn(spawnOpts(mission('user-without'))), /credential resolver failed/);
    assert.equal(isBackendName('launch-async'), false);
    assert.match(inactiveProfiles().find((p) => p.id === 'launch-async')?.reason ?? '', /checked again after a mission failed/);

    // The probe speaks for everyone: the other accounts get the backend back.
    release();
    await recheckCredentials();
    assert.equal(isBackendName('launch-async'), true);
    const spec = await backend.buildSpawn(spawnOpts(mission('user-ok')));
    assert.equal(spec.env?.TOKEN, 'k');

    // A loss the probe confirms keeps it out.
    lost = true;
    gate = new Promise((resolve) => { release = resolve; });
    await assert.rejects(backend.buildSpawn(spawnOpts(mission('user-ok'))), /credential resolver failed/);
    assert.equal(isBackendName('launch-async'), false);
    release();
    await recheckCredentials();
    assert.equal(isBackendName('launch-async'), false);
    assert.match(inactiveProfiles().find((p) => p.id === 'launch-async')?.reason ?? '', /credential resolver failed/);
  } finally {
    off();
  }
});

test('a session over a local process receives the context too', () => {
  const off = registerProfile(OWNER, { ...shape, id: 'launch-session', dialect: 'launch-session', env: {} });
  try {
    const id = mission('user-3');
    getBackend('launch-session').openSession!({
      io: { stdin: new PassThrough(), stdout: new PassThrough() },
      spawn: spawnOpts(id),
      host: { emit: () => {}, requestPermission: async () => ({ allow: false }) },
    } as unknown as Parameters<NonNullable<ReturnType<typeof getBackend>['openSession']>>[0]);
    assert.deepEqual(openedLocal.at(-1)?.launch,
      { kind: 'mission', missionId: id, ownerUserId: 'user-3', agentName: 'acme.coder', project: 'acme' });
  } finally {
    off();
  }
});
