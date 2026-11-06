/**
 * The annotate commands (TODO #468) through the generic command route. The desktop lets a pick in
 * on `commandActor: 'human'` alone, so the value must be the daemon's; and what it hands back
 * (page text, outerHTML, thumbnail) must reach the sealed store, never the response. The fake
 * provider applies the desktop's own rule sets, imported from `desktop/src/native-browser-annotator.ts`.
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
import { getBrowserAnnotation, listBrowserAnnotations, readBrowserAnnotation } from '../../browser-annotations.js';
import { NativeBrowserError } from '../../native-browser-provider.js';
import { resolveMasterKey } from '../../secrets/key.js';

const desktop = await import(new URL('../../../../desktop/src/native-browser-annotator.ts', import.meta.url).href) as typeof import('../../../../desktop/src/native-browser-annotator.js');
resolveMasterKey({ keyring: null });

const alice = createTestAccount(dbApi, { email: 'ann-native-alice@example.test', name: 'Alice', passwordHash: 'unused' });
const bob = createTestAccount(dbApi, { email: 'ann-native-bob@example.test', name: 'Bob', passwordHash: 'unused' });
const aliceCookie = randomUUID();
const bobCookie = randomUUID();
dbApi.createSession({ tokenHash: hashSessionToken(aliceCookie), userId: alice.id, expiresAt: Date.now() + 60_000 });
dbApi.createSession({ tokenHash: hashSessionToken(bobCookie), userId: bob.id, expiresAt: Date.now() + 60_000 });
const profile = createBrowserProfile({ name: 'Annotated', owner_user_id: alice.id });
const mission = randomUUID();
dbApi.createMission(mission, 'ann-native-agent', 'test', undefined, alice.id);
dbApi.setMissionBrowserProfile(mission, profile.id);
const missionToken = issueMissionApiToken(mission);

const PAGE = 'page-text-only-for-the-store';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');
const capture = () => ({
  version: 1, id: randomUUID(), capturedAt: new Date().toISOString(), tabId: 't1', url: 'http://localhost:5173/cart', title: 'Cart',
  point: { x: 1, y: 1 }, rect: { x: 0, y: 0, width: 50, height: 20 }, viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 },
  target: { selector: '#buy', xpath: '/html[1]/body[1]/button[1]', tag: 'button', role: 'button', name: 'Buy', text: PAGE, inputType: '', id: 'buy', classes: [], locators: [] },
  outerHtml: `<button>${PAGE}</button>`, outerHtmlTruncated: false,
  source: { detected: false },
  thumbnail: { mimeType: 'image/jpeg', data: JPEG, width: 50, height: 20 },
});

/** The desktop engine's annotate rules, nothing else. */
const engine = { active: false, picks: [] as unknown[], reached: [] as Record<string, unknown>[] };
const state = () => ({ active: engine.active, pending: engine.picks.length, capturing: 0 });
const fakeDesktop = async (_id: string, command: Record<string, unknown>): Promise<unknown> => {
  const action = String(command.action);
  const human = command.commandActor === 'human';
  if (desktop.ANNOTATION_CONTROL_COMMANDS.has(action) && !human) throw new NativeBrowserError('Only the user can annotate the browser.', 403);
  if (!human && engine.active && !desktop.ANNOTATION_AGENT_ALLOWED_COMMANDS.has(action)) throw new NativeBrowserError('The user is annotating this browser.', 409);
  engine.reached.push(command);
  const status = { running: true, tabs: [], activeTabId: 't1', annotation: state() };
  if (action === 'annotateStart') { engine.active = true; return { ...status, annotation: state() }; }
  if (action === 'annotatePick') {
    if (command.preview) return { hover: { rect: { x: 0, y: 0, width: 5, height: 5 }, tag: 'button' } };
    return { annotation: capture() };
  }
  if (action === 'annotateCollect' || action === 'annotateStop') {
    if (action === 'annotateStop') engine.active = false;
    const picks = engine.picks;
    engine.picks = [];
    const annotation = { ...state(), picks };
    return action === 'annotateStop' ? { ...status, annotation } : { annotation };
  }
  if (action === 'stop') { engine.active = false; engine.picks = []; return { ...status, running: false, annotation: state() }; }
  return status;
};

const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'ann-native-daemon' }));
app.use(express.json());
registerNativeBrowserRoutes(app, { capabilities: async () => ({ available: true }), call: fakeDesktop });
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
  if (who === 'daemon') headers.authorization = 'Bearer ann-native-daemon';
  const res = await fetch(`${base}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { result?: Record<string, any>; error?: string } };
}
const own = (action: string, extra: Record<string, unknown> = {}, who: Who = 'alice') =>
  post(`${profile.id}/command`, { action, clientId: 'alice-pane-1', ...extra }, who);
const drafts = () => listBrowserAnnotations({ ownerUserId: alice.id, profileId: profile.id });

test('annotate commands exist, are the user\'s alone, and match the desktop\'s sets', () => {
  for (const action of desktop.ANNOTATION_CONTROL_COMMANDS) {
    assert.ok(NATIVE_COMMAND_SETS.commands.has(action), action);
    assert.ok(NATIVE_COMMAND_SETS.humanOnly.has(action), action);
    assert.ok(NATIVE_COMMAND_SETS.ownerOnly.has(action), action);
    assert.ok(!NATIVE_COMMAND_SETS.reads.has(action), `${action} takes the control lease like any human command`);
  }
  // A read the daemon forwards must stay possible for an agent while the user annotates.
  for (const action of NATIVE_COMMAND_SETS.reads) {
    if (action === 'listCredentials') continue; // answered by the daemon, never forwarded
    assert.ok(desktop.ANNOTATION_AGENT_ALLOWED_COMMANDS.has(action), action);
  }
});

test('an agent, another account, the daemon token and an anonymous never annotate, whatever actor they claim', async () => {
  engine.reached.length = 0;
  for (const action of desktop.ANNOTATION_CONTROL_COMMANDS) {
    for (const claim of [{}, { commandActor: 'human' }]) {
      assert.equal((await post('mission/command', { action, x: 1, y: 1, ...claim }, 'mission')).status, 403, action);
    }
    assert.equal((await own(action, { x: 1, y: 1 }, 'bob')).status, 404, `${action}: another account does not see the profile`);
    assert.equal((await post(`${profile.id}/command`, { action, x: 1, y: 1, commandActor: 'human' }, 'daemon')).status, 404, `${action}: the daemon token is not the owner`);
    assert.equal((await post(`${profile.id}/command`, { action, x: 1, y: 1 }, 'anonymous')).status, 401, action);
  }
  assert.equal(engine.reached.length, 0, 'refused before the desktop');
  assert.equal(engine.active, false);
});

test('the owner annotates: the actor is the daemon\'s, picks are sealed, the answer holds metadata only', async () => {
  const before = drafts().length;
  const started = await own('annotateStart', { commandActor: 'agent' });
  assert.equal(started.status, 200);
  assert.equal(engine.reached.at(-1)?.commandActor, 'human', 'set by the authentication, not read from the body');
  assert.equal(started.json.result!.annotation.active, true);

  // The PWA's hover preview answers the outline, and stores nothing.
  const hover = await own('annotatePick', { x: 10, y: 20, preview: true });
  assert.equal(hover.status, 200);
  assert.deepEqual(Object.keys(hover.json.result!), ['hover']);
  assert.equal(drafts().length, before);

  const picked = await own('annotatePick', { x: 10, y: 20 });
  assert.equal(picked.status, 200);
  assert.equal(picked.text.includes(PAGE), false, 'no page text in the response');
  assert.equal(picked.text.includes(JPEG.slice(0, 40)), false, 'no thumbnail in the response');
  assert.equal(picked.json.result!.annotations.length, 1);
  const meta = getBrowserAnnotation(picked.json.result!.annotations[0].id)!;
  assert.deepEqual([meta.ownerUserId, meta.profileId, meta.status, meta.hasThumbnail], [alice.id, profile.id, 'draft', true]);
  assert.equal(readBrowserAnnotation(meta).capture.target.text, PAGE, 'kept in the sealed store');

  // The native view's picks wait on the desktop until collected, then until the stop.
  engine.picks = [capture(), capture()];
  const collected = await own('annotateCollect');
  assert.equal(collected.status, 200);
  assert.equal(collected.text.includes(PAGE), false);
  assert.equal('picks' in collected.json.result!.annotation, false);
  assert.deepEqual([collected.json.result!.annotations.length, collected.json.result!.annotation.active], [2, true]);

  engine.picks = [capture()];
  const stopped = await own('annotateStop');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.text.includes(PAGE), false);
  assert.equal('picks' in stopped.json.result!.annotation, false);
  assert.deepEqual([stopped.json.result!.annotations.length, stopped.json.result!.annotation.active], [1, false]);
  assert.ok(stopped.json.result!.control, 'a status answer keeps its control lease');
  assert.equal(drafts().length, before + 4);
});

test('an agent is held off while the user annotates, its reads excepted', async () => {
  assert.equal((await own('annotateStart')).status, 200);
  for (const body of [{ action: 'navigate', url: 'https://evil.example' }, { action: 'input', event: { type: 'mouse', x: 1, y: 1 } }, { action: 'stop' }]) {
    assert.equal((await post('mission/command', { ...body, commandActor: 'human' }, 'mission')).status, 409, body.action);
  }
  assert.equal((await post('mission/command', { action: 'screenshot', commandActor: 'human' }, 'mission')).status, 200);
  assert.equal(engine.reached.at(-1)?.commandActor, 'agent');
  assert.equal((await own('annotateStop')).status, 200);
});

test('stopping the browser keeps the picks still waiting on the desktop, and hands nobody their content', async () => {
  const before = drafts().length;
  await own('annotateStart');
  engine.picks = [capture()];
  const stopped = await own('stop');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.text.includes(PAGE), false);
  assert.equal(drafts().length, before + 1, 'the user\'s stop collects the pick first');

  // Annotate mode ended on its own (idle): the agent is no longer excluded and stops the browser.
  await own('annotateStart');
  engine.active = false;
  engine.picks = [capture()];
  const agentStop = await post('mission/command', { action: 'stop' }, 'mission');
  assert.equal(agentStop.status, 200);
  assert.equal(agentStop.text.includes(PAGE), false, 'the agent gets nothing of the pick');
  const saved = drafts();
  assert.equal(saved.length, before + 2);
  assert.equal(saved.every((meta) => meta.ownerUserId === alice.id), true, 'collected into the owner\'s store');
});
