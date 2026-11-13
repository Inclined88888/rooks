/**
 * The recording exclusion of the agent (TODO #461) is enforced by the desktop on the
 * `commandActor` the daemon sets. The fake provider below applies the desktop's own rule sets,
 * imported from `desktop/src/native-browser-recorder.ts`, so these tests fail if the daemon ever
 * lets a caller choose its actor or hands recorded steps back in a response.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi } from '../../db.js';
import { createBrowserProfile } from '../../browser-profiles.js';
import { issueMissionApiToken } from '../../users/api-tokens.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { NATIVE_COMMAND_SETS, registerNativeBrowserRoutes } from './native-routes.js';
import { registerBrowserRecordingRoutes } from '../browser-recording/routes.js';
import { upsertBrowserCredential } from '../../browser-credentials.js';
import { getBrowserRecording, listBrowserRecordings, readBrowserRecordingSteps } from '../../browser-recordings.js';
import { NativeBrowserError } from '../../native-browser-provider.js';
import { resolveMasterKey } from '../../secrets/key.js';

const desktop = await import(new URL('../../../../desktop/src/native-browser-recorder.ts', import.meta.url).href) as typeof import('../../../../desktop/src/native-browser-recorder.js');
resolveMasterKey({ keyring: null });

const alice = createTestAccount(dbApi, { email: 'rec-alice@example.test', name: 'Alice', passwordHash: 'unused' });
const bob = createTestAccount(dbApi, { email: 'rec-bob@example.test', name: 'Bob', passwordHash: 'unused' });
const aliceCookie = randomUUID();
const bobCookie = randomUUID();
dbApi.createSession({ tokenHash: hashSessionToken(aliceCookie), userId: alice.id, expiresAt: Date.now() + 60_000 });
dbApi.createSession({ tokenHash: hashSessionToken(bobCookie), userId: bob.id, expiresAt: Date.now() + 60_000 });
const profile = createBrowserProfile({ name: 'Recorded', owner_user_id: alice.id });
const mission = randomUUID();
dbApi.createMission(mission, 'rec-agent', 'test', undefined, alice.id);
dbApi.setMissionBrowserProfile(mission, profile.id);
const missionToken = issueMissionApiToken(mission);
const TYPED = 'typed-by-alice-only';

/** The desktop engine's recording rules, nothing else. */
const engine = { active: false, finished: false, reached: [] as Record<string, unknown>[] };
const recorded = () => ({ version: 1, startedAt: new Date().toISOString(), url: 'https://shop.example/', truncated: false,
  stoppedReason: engine.active ? 'user' : 'idle',
  steps: [{ t: 0, type: 'navigate', tabId: 't1', url: 'https://shop.example/?code=oauth-code' },
    { t: 1, type: 'input', tabId: 't1', selector: '#q', inputType: 'text', name: 'Search', value: TYPED }] });
const fakeDesktop = async (_id: string, command: Record<string, unknown>): Promise<unknown> => {
  const action = String(command.action);
  const human = command.commandActor === 'human';
  if (desktop.RECORDING_CONTROL_COMMANDS.has(action) && !human) throw new NativeBrowserError('Only the user can start or stop a browser recording.', 403);
  if (!human && engine.active && !desktop.RECORDING_AGENT_ALLOWED_COMMANDS.has(action)) throw new NativeBrowserError('The user is recording this browser.', 409);
  engine.reached.push(command);
  const status = { running: true, tabs: [], activeTabId: null, recording: { active: engine.active, steps: 2, ...(engine.finished ? { stoppedReason: 'idle' } : {}) } };
  if (action === 'recordStart') { engine.active = true; engine.finished = false; return status; }
  if (action === 'recordStatus') return { recording: status.recording };
  if (action === 'recordStop') {
    if (!engine.active && !engine.finished) throw new NativeBrowserError('This browser has no recording to stop.', 409);
    const recording = recorded();
    engine.active = engine.finished = false;
    return { recording };
  }
  if (action === 'stop') {
    const recording = engine.active || engine.finished ? recorded() : null;
    engine.active = engine.finished = false;
    return { ...status, running: false, ...(recording && human ? { recordingResult: recording } : {}) };
  }
  if (action === 'fillCredential') return { filled: true };
  if (action === 'captureCredential') return { origin: 'https://login.example', username: 'u', password: 'p' };
  return status;
};

const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'rec-test-daemon' }));
app.use(express.json());
registerNativeBrowserRoutes(app, { capabilities: async () => ({ available: true }), call: fakeDesktop });
// The user's Stop goes through the recording plugin's route, on the same desktop.
registerBrowserRecordingRoutes(app, { call: fakeDesktop });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/native-browser`;
type Who = 'alice' | 'bob' | 'mission' | 'daemon' | 'anonymous';
async function post(path: string, body: Record<string, unknown>, who: Who = 'alice') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who === 'alice') headers.cookie = `${SESSION_COOKIE}=${aliceCookie}`;
  if (who === 'bob') headers.cookie = `${SESSION_COOKIE}=${bobCookie}`;
  if (who === 'mission') headers.authorization = `Bearer ${missionToken}`;
  if (who === 'daemon') headers.authorization = 'Bearer rec-test-daemon';
  const res = await fetch(`${base}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { result?: Record<string, any>; error?: string } };
}
const own = (action: string, extra: Record<string, unknown> = {}, who: Who = 'alice') =>
  post(`${profile.id}/command`, { action, clientId: 'alice-pane-1', ...extra }, who);

test('record commands exist, are the user\'s alone, and match the desktop\'s sets', () => {
  for (const action of desktop.RECORDING_CONTROL_COMMANDS) {
    assert.ok(NATIVE_COMMAND_SETS.commands.has(action), action);
    assert.ok(NATIVE_COMMAND_SETS.humanOnly.has(action), action);
    assert.ok(NATIVE_COMMAND_SETS.ownerOnly.has(action), action);
  }
  assert.ok(NATIVE_COMMAND_SETS.commands.has('recordStatus'));
  // A read the daemon forwards must stay possible for an agent while the user records.
  for (const action of NATIVE_COMMAND_SETS.reads) {
    if (action === 'listCredentials') continue; // answered by the daemon, never forwarded
    assert.ok(desktop.RECORDING_AGENT_ALLOWED_COMMANDS.has(action), action);
  }
});

test('an agent cannot start, stop or collect a recording, whatever actor it claims', async () => {
  engine.reached.length = 0;
  for (const action of ['recordStart', 'recordStop']) {
    for (const claim of [{}, { commandActor: 'human' }]) {
      assert.equal((await post('mission/command', { action, ...claim }, 'mission')).status, 403, action);
    }
  }
  assert.equal(engine.reached.length, 0, 'refused before the desktop');
  assert.equal((await own('recordStart', {}, 'bob')).status, 404, 'another account does not see the profile');
  assert.equal((await post(`${profile.id}/command`, { action: 'recordStart' }, 'daemon')).status, 404, 'the daemon token is not the owner');
  assert.equal((await post(`${profile.id}/command`, { action: 'recordStart' }, 'anonymous')).status, 401);
  assert.equal(engine.active, false);
});

test('a mission token claiming commandActor human is still refused while the user records', async () => {
  const credential = upsertBrowserCredential(profile, { origin: 'https://login.example', username: 'alice', password: 'pw' });
  assert.equal((await own('recordStart')).status, 200);
  assert.equal(engine.reached.at(-1)?.commandActor, 'human');
  for (const body of [{ action: 'navigate', url: 'https://evil.example' }, { action: 'input', event: { type: 'key', key: 'Enter' } },
    { action: 'fillCredential', credentialId: credential.id }, { action: 'stop' }]) {
    const refused = await post('mission/command', { ...body, commandActor: 'human' }, 'mission');
    assert.equal(refused.status, 409, body.action);
  }
  // Reads stay open to the agent, and are marked as its own.
  assert.equal((await post('mission/command', { action: 'screenshot', commandActor: 'human' }, 'mission')).status, 200);
  assert.equal(engine.reached.at(-1)?.commandActor, 'agent');
  // The user keeps driving, and their credential fill names the entry, never its secret.
  assert.equal((await own('fillCredential', { credentialId: credential.id, commandActor: 'agent' })).status, 200);
  assert.deepEqual([engine.reached.at(-1)?.commandActor, engine.reached.at(-1)?.credentialId], ['human', credential.id]);
});

test('recordStop seals the steps and answers with metadata only', async () => {
  const stopped = await own('recordStop');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.text.includes(TYPED), false, 'no typed value in the response');
  assert.equal(stopped.text.includes('oauth-code'), false);
  const meta = getBrowserRecording(stopped.json.result!.recording.id)!;
  assert.equal(meta.profileId, profile.id);
  assert.equal(meta.ownerUserId, alice.id);
  assert.equal(readBrowserRecordingSteps(meta)![1]!.value, TYPED);
  assert.ok(!readBrowserRecordingSteps(meta)![0]!.url!.includes('oauth-code'), 'the URL token is masked again');
  assert.equal((await own('recordStop')).status, 409);
});

test('stopping the browser never returns recordingResult; an agent\'s stop collects it into the store', async () => {
  const before = listBrowserRecordings({ ownerUserId: alice.id }).length;
  await own('recordStart');
  const stopped = await own('stop');
  assert.equal(stopped.status, 200);
  assert.equal('recordingResult' in stopped.json.result!, false);
  assert.equal(stopped.text.includes(TYPED), false);
  assert.ok(getBrowserRecording(stopped.json.result!.recordingSaved.id));
  // The recording ended on its own (idle): the agent is no longer excluded and stops the browser.
  await own('recordStart');
  engine.active = false;
  engine.finished = true;
  const agentStop = await post('mission/command', { action: 'stop', commandActor: 'human' }, 'mission');
  assert.equal(agentStop.status, 200);
  assert.equal(agentStop.text.includes(TYPED), false, 'the agent gets nothing of the steps');
  assert.equal(engine.reached.at(-1)?.commandActor, 'agent');
  assert.equal(listBrowserRecordings({ ownerUserId: alice.id }).length, before + 2, 'the user keeps both recordings');
});

test('the user\'s Stop after the daemon collected the recording names that recording instead of failing', async () => {
  await own('recordStart');
  engine.active = false;
  engine.finished = true;
  // The pill still shows the recording; meanwhile an agent stops the browser and the daemon collects it.
  assert.equal((await post('mission/command', { action: 'stop' }, 'mission')).status, 200);
  const collected = listBrowserRecordings({ ownerUserId: alice.id })[0]!;
  assert.equal(collected.stoppedReason, 'idle');
  // Another account still sees nothing, and the agent cannot ask either.
  assert.equal((await post(`${profile.id}/recording/stop`, {}, 'bob')).status, 404);
  assert.equal((await post('mission/command', { action: 'recordStop' }, 'mission')).status, 403);
  const stopped = await post(`${profile.id}/recording/stop`, {});
  assert.equal(stopped.status, 200);
  const answer = stopped.json as unknown as { recording: { id: string }; alreadySaved?: boolean };
  assert.deepEqual([answer.recording.id, answer.alreadySaved], [collected.id, true]);
  assert.equal(stopped.text.includes(TYPED), false, 'metadata only, as for any stop');
  // Said once: a second Stop gets the desktop's refusal again.
  assert.equal((await post(`${profile.id}/recording/stop`, {})).status, 409);
});

test('the raw recordStop command answers the same way, and a new recording forgets the collected one', async () => {
  await own('recordStart');
  engine.active = false;
  engine.finished = true;
  await post('mission/command', { action: 'stop' }, 'mission');
  const collected = listBrowserRecordings({ ownerUserId: alice.id })[0]!;
  const stopped = await own('recordStop');
  assert.equal(stopped.status, 200);
  assert.deepEqual([stopped.json.result!.recording.id, stopped.json.result!.alreadySaved], [collected.id, true]);
  // Collected, then a new recording started and lost by the desktop: the Stop no longer points at the old one.
  await own('recordStart');
  engine.active = false;
  engine.finished = true;
  await post('mission/command', { action: 'stop' }, 'mission');
  assert.equal((await post(`${profile.id}/recording/start`, {})).status, 200);
  engine.active = false;
  assert.equal((await post(`${profile.id}/recording/stop`, {})).status, 409);
});

test('saving a login from the page is marked with the user\'s actor', async () => {
  assert.equal((await own('saveCredentialFromPage', { commandActor: 'agent' })).status, 200);
  assert.deepEqual(engine.reached.at(-1), { action: 'captureCredential', commandActor: 'human' });
});
