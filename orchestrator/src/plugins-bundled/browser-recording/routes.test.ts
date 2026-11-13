import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi } from '../../db.js';
import { createBrowserProfile } from '../../browser-profiles.js';
import { issueMissionApiToken } from '../../users/api-tokens.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { registerBrowserRecordingRoutes } from './routes.js';
import { getBrowserRecording } from '../../browser-recordings.js';
import { agentDir } from '../../paths.js';
import { resolveMasterKey } from '../../secrets/key.js';

resolveMasterKey({ keyring: null });
mkdirSync(agentDir('rec-learner'), { recursive: true });
// An agent whose backend keeps its shell (TODO #469): Learn never starts a conversion on it.
mkdirSync(agentDir('rec-shell'), { recursive: true });
const UNSAFE = 'this backend cannot run a recording conversion safely: test';

const alice = createTestAccount(dbApi, { email: 'rr-alice@example.test', name: 'Alice', passwordHash: 'unused' });
const bob = createTestAccount(dbApi, { email: 'rr-bob@example.test', name: 'Bob', passwordHash: 'unused' });
const cookies = { alice: randomUUID(), bob: randomUUID() };
dbApi.createSession({ tokenHash: hashSessionToken(cookies.alice), userId: alice.id, expiresAt: Date.now() + 60_000 });
dbApi.createSession({ tokenHash: hashSessionToken(cookies.bob), userId: bob.id, expiresAt: Date.now() + 60_000 });
const profile = createBrowserProfile({ name: 'Alice browser', owner_user_id: alice.id });
const bobProfile = createBrowserProfile({ name: 'Bob browser', owner_user_id: bob.id });
// An agent assigned to the profile: the browser is its, the recordings are not.
const assigned = randomUUID();
dbApi.createMission(assigned, 'rec-learner', 'test', undefined, alice.id);
dbApi.setMissionBrowserProfile(assigned, profile.id);
const tokens: Record<string, string> = { assigned: issueMissionApiToken(assigned) };

const TYPED = 'running shoes';
const KEY = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
const reached: Record<string, unknown>[] = [];
const spawned: Array<{ agent: string; brief: string; opts: Record<string, unknown> }> = [];
let spawnFails = false;
const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'rr-daemon' }));
app.use(express.json());
registerBrowserRecordingRoutes(app, {
  call: async (_id, command) => {
    reached.push(command);
    if (command.action === 'recordStart') return { running: true, recording: { active: true, steps: 1 } };
    return { recording: { version: 1, startedAt: new Date().toISOString(), url: 'https://shop.example/', truncated: false, stoppedReason: 'user',
      steps: [{ t: 0, type: 'navigate', tabId: 't', url: 'https://shop.example/' },
        { t: 1, type: 'input', tabId: 't', selector: '#q', inputType: 'text', name: 'Search', value: TYPED },
        { t: 2, type: 'input', tabId: 't', selector: '#k', inputType: 'text', name: 'Key', value: KEY },
        { t: 3, type: 'credential', tabId: 't', origin: 'https://shop.example', credentialId: 'bc-123' }] } };
  },
  spawn: async (agent, brief, _source, opts) => {
    if (spawnFails) throw new Error('backend down');
    spawned.push({ agent, brief, opts });
    dbApi.createMission(opts.missionId, agent, brief, undefined, opts.ownerUserId);
    tokens[opts.missionId] = issueMissionApiToken(opts.missionId);
    return opts.missionId;
  },
  learnSkillId: 'learn-browser-recording-test',
  conversionRefusal: (agent) => (agent === 'rec-shell' ? UNSAFE : null),
  agentNames: () => ['rec-shell', 'rec-learner', 'rec-gone'],
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/native-browser`;

async function http(method: string, path: string, who: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who === 'alice' || who === 'bob') headers.cookie = `${SESSION_COOKIE}=${cookies[who]}`;
  else if (who === 'daemon') headers.authorization = 'Bearer rr-daemon';
  else if (who !== 'anonymous') headers.authorization = `Bearer ${tokens[who]}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, any>, cache: res.headers.get('cache-control') };
}

let recordingId = '';

test('the owner records: start and stop reach the desktop as human, the response holds metadata only', async () => {
  const started = await http('POST', `${profile.id}/recording/start`, 'alice', {});
  assert.equal(started.status, 200);
  assert.equal(started.cache, 'no-store');
  assert.deepEqual(reached.at(-1), { action: 'recordStart', commandActor: 'human' });
  const stopped = await http('POST', `${profile.id}/recording/stop`, 'alice', { clientId: 'alice-pane-1' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.text.includes(TYPED), false);
  assert.equal(stopped.text.includes(KEY), false);
  recordingId = stopped.json.recording.id;
  assert.equal(stopped.json.recording.flagged, 1);
  const list = await http('GET', `${profile.id}/recordings`, 'alice');
  assert.deepEqual(list.json.recordings.map((row: { id: string }) => row.id), [recordingId]);
  const read = await http('GET', `recordings/${recordingId}`, 'alice');
  assert.equal(read.json.steps[1].value, TYPED, 'the owner reviews the real values');
});

test('anonymous, the daemon token, a mission token and another owner are all refused', async () => {
  const count = reached.length;
  const routes: Array<[string, string, unknown?]> = [
    ['POST', `${profile.id}/recording/start`, {}], ['POST', `${profile.id}/recording/stop`, {}],
    ['GET', `${profile.id}/recordings`], ['GET', `recordings/${recordingId}`],
    ['PATCH', `recordings/${recordingId}`, { ops: [] }], ['DELETE', `recordings/${recordingId}`],
    ['POST', `recordings/${recordingId}/learn`, {}], ['GET', `recordings/${recordingId}/learn-agents`],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await http(method, path, 'anonymous', body)).status, 401, `${method} ${path}`);
    const daemon = await http(method, path, 'daemon', body);
    assert.ok([403, 404].includes(daemon.status), `daemon ${method} ${path}: ${daemon.status}`);
    const mission = await http(method, path, 'assigned', body);
    assert.ok([403, 404].includes(mission.status), `mission ${method} ${path}: ${mission.status}`);
    assert.equal(mission.text.includes(TYPED), false);
    assert.equal((await http(method, path, 'bob', body)).status, 404, `bob ${method} ${path}`);
  }
  assert.equal((await http('GET', `${bobProfile.id}/recordings`, 'alice')).status, 404);
  assert.equal(reached.length, count, 'nothing refused reached the desktop');
  assert.ok(getBrowserRecording(recordingId), 'nothing refused deleted it');
});

test('inputs are validated before anything happens', async () => {
  assert.equal((await http('PATCH', `recordings/${recordingId}`, 'alice', { ops: [{ op: 'explode', step: 1 }] })).status, 400);
  assert.equal((await http('PATCH', `recordings/${recordingId}`, 'alice', { ops: [], extra: true })).status, 400);
  assert.equal((await http('POST', `recordings/${recordingId}/learn`, 'alice', { agent: '../etc' })).status, 400);
  assert.equal((await http('POST', `${profile.id}/recording/start`, 'alice', { clientId: 'x' })).status, 400);
  assert.equal((await http('GET', 'recordings/not-an-id', 'alice')).status, 404);
});

test('learning waits for the flagged step, then starts the one mission that may read the steps', async () => {
  const early = await http('POST', `recordings/${recordingId}/learn`, 'alice', { agent: 'rec-learner' });
  assert.equal(early.status, 409);
  assert.match(early.json.error, /flagged/);
  const reviewed = await http('PATCH', `recordings/${recordingId}`, 'alice', { ops: [{ op: 'mask', step: 3 }] });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.json.recording.status, 'reviewed');
  spawnFails = true;
  assert.equal((await http('POST', `recordings/${recordingId}/learn`, 'alice', { agent: 'rec-learner' })).status, 503);
  assert.equal(getBrowserRecording(recordingId)!.status, 'reviewed', 'a failed spawn leaves the recording as it was');
  spawnFails = false;
  assert.equal((await http('POST', `recordings/${recordingId}/learn`, 'alice', { agent: 'nobody-here' })).status, 404);
  const spawns = spawned.length;
  const unsafe = await http('POST', `recordings/${recordingId}/learn`, 'alice', { agent: 'rec-shell' });
  assert.equal(unsafe.status, 400);
  assert.equal(unsafe.json.error, UNSAFE);
  assert.equal(spawned.length, spawns, 'nothing spawned on a backend that keeps its shell');
  assert.equal(getBrowserRecording(recordingId)!.status, 'reviewed');
  assert.equal(getBrowserRecording(recordingId)!.learnMissionId, null);
  const learned = await http('POST', `recordings/${recordingId}/learn`, 'alice', { agent: 'rec-learner', autoSubmit: false });
  assert.equal(learned.status, 200);
  const missionId = learned.json.missionId as string;
  assert.equal(learned.json.recording.learnMissionId, missionId);
  const call = spawned.at(-1)!;
  assert.equal(call.agent, 'rec-learner');
  assert.deepEqual(call.opts.extraSkills, ['learn-browser-recording-test']);
  assert.equal(call.opts.browserProfileId, profile.id);
  assert.equal(call.opts.ownerUserId, alice.id);
  assert.match(call.brief, new RegExp(recordingId));
  assert.equal(call.brief.includes(TYPED), false, 'the brief names the recording, it does not carry it');
  assert.equal((await http('POST', `recordings/${recordingId}/learn`, 'alice', { agent: 'rec-learner' })).status, 409);

  const read = await http('GET', `recordings/${recordingId}`, missionId);
  assert.equal(read.status, 200);
  assert.equal(read.cache, 'no-store');
  assert.equal(read.json.steps[1].value, TYPED);
  assert.equal(read.text.includes(KEY), false, 'the masked value is gone');
  assert.equal(read.text.includes('bc-123'), false, 'credential ids stay out of the conversion');
  assert.equal(read.json.recording.ownerUserId, undefined);
  assert.equal((await http('GET', `recordings/${recordingId}`, 'assigned')).status, 404, 'the profile\'s agent is not the conversion');
});

test('the conversion mission of one recording cannot read another', async () => {
  await http('POST', `${profile.id}/recording/start`, 'alice', {});
  const other = (await http('POST', `${profile.id}/recording/stop`, 'alice', {})).json.recording.id as string;
  const conversion = Object.keys(tokens).find((key) => key !== 'assigned')!;
  assert.equal((await http('GET', `recordings/${other}`, conversion)).status, 404);
  assert.equal((await http('GET', `${profile.id}/recordings`, conversion)).status, 403, 'no list for agents');
  assert.equal((await http('DELETE', `recordings/${other}`, 'alice')).json.deleted, true);
  assert.equal(getBrowserRecording(other), undefined);
});

test('Learn offers only the agents whose backend runs without a shell, and only to the owner', async () => {
  await http('POST', `${profile.id}/recording/start`, 'alice', {});
  const draft = (await http('POST', `${profile.id}/recording/stop`, 'alice', {})).json.recording.id as string;
  const offered = await http('GET', `recordings/${draft}/learn-agents`, 'alice');
  assert.equal(offered.status, 200);
  assert.equal(offered.cache, 'no-store');
  assert.deepEqual(offered.json.agents, [{ name: 'rec-learner', main: false }], 'neither the unsafe agent nor one without a folder');
  assert.equal((await http('GET', `recordings/${draft}/learn-agents`, 'bob')).status, 404);
  await http('DELETE', `recordings/${draft}`, 'alice');
});
