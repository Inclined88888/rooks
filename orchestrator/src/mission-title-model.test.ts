/**
 * Which model titles a conversation (TODO #358, part C): the account's choice
 * wins over the instance setting, which wins over the shipped `auto`; a backend
 * served remotely is refused; an account never reads nor writes another's
 * choice; a value outside the eligible list is a 400.
 *
 * `npm test -- src/mission-title-model.test.ts`
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'rooks-title-model-'));
process.env.ROOKS_HOME = HOME;
// The instance setting comes from the config file, like an operator would write it.
writeFileSync(join(HOME, 'rooks.config.json'), JSON.stringify({ settings: { ROOKS_MISSION_TITLE_MODEL: 'claude:haiku' } }));
await import('../tests/helpers/paid-license.js');
await import('../tests/helpers/claude-provider.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const { dbApi } = await import('./db.js');
const { SESSION_COOKIE, hashSessionToken, issueSessionToken } = await import('./users/session.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { memoryDialect } = await import('../tests/helpers/example-dialects.js');
const {
  effectiveTitleModel, instanceTitleModel, lightestModel, parseTitleModelChoice, resolveMissionTitleLlm,
  serializeTitleModelChoice, titleBackends, titleChoiceRefusal,
} = await import('./mission-title-model.js');

// A backend served remotely: it runs no local process, so it cannot title.
registerDialect('title-model-test', 'memory-remote', memoryDialect);
registerProfile('title-model-test', { id: 'faraway', dialect: 'memory-remote', label: 'Far away', defaultModel: null, models: [], env: {} });
invalidateSettingsCache();

const TOKEN = 'witness-title-model-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

function sessionFor(userId: string): string {
  const raw = issueSessionToken();
  dbApi.createSession({ tokenHash: hashSessionToken(raw), userId, expiresAt: Date.now() + 60_000 });
  return raw;
}
async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: 'x', isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: 'x', isSuperadmin: false });
const adaCookie = sessionFor(ada.id);
const bobCookie = sessionFor(bob.id);

function missionOf(ownerId: string | null, backendOverride: string | null = null) {
  const id = randomUUID();
  dbApi.createMission(id, 'rooks.main', 'Hello', undefined, ownerId);
  if (backendOverride) dbApi.setMissionLlmOverrides(id, backendOverride, null);
  return dbApi.getMission(id)!;
}

test('a choice is one string: auto, off, or backend:model split at the first colon', () => {
  assert.deepEqual(parseTitleModelChoice('auto'), { kind: 'auto' });
  assert.deepEqual(parseTitleModelChoice(''), { kind: 'auto' });
  assert.deepEqual(parseTitleModelChoice('off'), { kind: 'off' });
  assert.deepEqual(parseTitleModelChoice('ollama:qwen3:8b'), { kind: 'model', backend: 'ollama', model: 'qwen3:8b' });
  assert.deepEqual(parseTitleModelChoice(':x'), { kind: 'auto' }, 'a malformed string never names a backend');
  assert.equal(serializeTitleModelChoice({ backend: 'claude', model: 'haiku' }), 'claude:haiku');
});

test('auto picks the lightest tier of the backend; a remote backend is not eligible', () => {
  assert.deepEqual(lightestModel('claude'), { model: 'haiku', reason: 'tier' });
  const views = titleBackends();
  const claude = views.find((b) => b.id === 'claude');
  assert.equal(claude?.eligible, true);
  const faraway = views.find((b) => b.id === 'faraway');
  assert.deepEqual([faraway?.eligible, faraway?.reason], [false, 'remote']);
  assert.equal(titleChoiceRefusal({ backend: 'faraway', model: 'any' })?.code, 'ineligible');
  assert.equal(titleChoiceRefusal({ backend: 'claude', model: 'no-such-model' })?.code, 'unknown_model');
  assert.equal(titleChoiceRefusal({ backend: 'claude', model: 'haiku' }), null);
});

test('resolution: account choice > instance setting (config file) > auto', () => {
  assert.deepEqual(instanceTitleModel(), { choice: { kind: 'model', backend: 'claude', model: 'haiku' }, source: 'config' });
  // No account choice: the instance setting applies.
  assert.deepEqual(effectiveTitleModel(ada.id).level, 'instance');
  assert.deepEqual(resolveMissionTitleLlm(missionOf(ada.id)), { backend: 'claude', model: 'haiku' });
  // The account chose off: nothing is generated for its missions, whatever the instance says.
  dbApi.userMissionTitleModelSet(ada.id, 'off');
  assert.equal(resolveMissionTitleLlm(missionOf(ada.id)), 'off');
  // Bob is untouched by Ada's choice.
  assert.deepEqual(resolveMissionTitleLlm(missionOf(bob.id)), { backend: 'claude', model: 'haiku' });
  // The account chose auto: the mission's own backend, its lightest model; a remote backend moves to a local one.
  dbApi.userMissionTitleModelSet(ada.id, 'auto');
  assert.deepEqual(resolveMissionTitleLlm(missionOf(ada.id, 'claude')), { backend: 'claude', model: 'haiku' });
  assert.deepEqual(resolveMissionTitleLlm(missionOf(ada.id, 'faraway')), { backend: 'claude', model: 'haiku' });
  // An explicit choice the catalogue no longer backs falls back to auto, never to off.
  dbApi.userMissionTitleModelSet(ada.id, 'faraway:ghost');
  assert.deepEqual(resolveMissionTitleLlm(missionOf(ada.id, 'claude')), { backend: 'claude', model: 'haiku' });
  dbApi.userMissionTitleModelSet(ada.id, null);
});

test('GET: a session reads its own choice and the eligible list; PUT writes it; another account sees nothing of it', async () => {
  const before = await call('GET', '/api/mission-titles/model', { cookie: adaCookie });
  assert.equal(before.status, 200);
  assert.equal(before.json.value, null);
  assert.deepEqual(before.json.instance, { kind: 'model', backend: 'claude', model: 'haiku' });
  assert.equal(before.json.instance_source, 'config');
  const backends = before.json.backends as Array<{ id: string; eligible: boolean; reason?: string }>;
  assert.ok(backends.some((b) => b.id === 'claude' && b.eligible));
  assert.deepEqual(backends.find((b) => b.id === 'faraway'), { ...backends.find((b) => b.id === 'faraway'), eligible: false, reason: 'remote' });

  const put = await call('PUT', '/api/mission-titles/model', { cookie: adaCookie, body: { value: { backend: 'claude', model: 'haiku' } } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.value, { kind: 'model', backend: 'claude', model: 'haiku' });
  assert.deepEqual((await call('GET', '/api/mission-titles/model', { cookie: adaCookie })).json.value, { kind: 'model', backend: 'claude', model: 'haiku' });

  // Bob reads his own (none) — Ada's choice never shows, and there is no `?user=` to ask for it.
  const bobView = await call('GET', '/api/mission-titles/model?user=' + ada.id, { cookie: bobCookie });
  assert.equal(bobView.json.value, null);
  await call('PUT', '/api/mission-titles/model?user=' + ada.id, { cookie: bobCookie, body: { value: 'off' } });
  assert.equal(dbApi.userMissionTitleModelGet(ada.id), 'claude:haiku', 'Bob wrote his own row, not Ada\'s');
  assert.equal(dbApi.userMissionTitleModelGet(bob.id), 'off');

  const cleared = await call('PUT', '/api/mission-titles/model', { cookie: adaCookie, body: { value: null } });
  assert.equal(cleared.status, 200);
  assert.equal(dbApi.userMissionTitleModelGet(ada.id), null);
  dbApi.userMissionTitleModelSet(bob.id, null);
});

test('PUT refuses a remote backend, an unknown model and a malformed body; anonymous is 401; daemon-token without account is 403', async () => {
  const remote = await call('PUT', '/api/mission-titles/model', { cookie: adaCookie, body: { value: { backend: 'faraway', model: 'x' } } });
  assert.deepEqual([remote.status, remote.json.code], [400, 'ineligible']);
  const unknown = await call('PUT', '/api/mission-titles/model', { cookie: adaCookie, body: { value: { backend: 'claude', model: 'gpt-9' } } });
  assert.deepEqual([unknown.status, unknown.json.code], [400, 'unknown_model']);
  assert.equal((await call('PUT', '/api/mission-titles/model', { cookie: adaCookie, body: { value: 'sometimes' } })).status, 400);
  assert.equal((await call('PUT', '/api/mission-titles/model', { cookie: adaCookie, body: { value: { backend: 'claude', model: 'haiku', extra: 1 } } })).status, 400);
  assert.equal((await call('PUT', '/api/mission-titles/model', { cookie: adaCookie, body: {} })).status, 400);
  assert.equal(dbApi.userMissionTitleModelGet(ada.id), null, 'nothing was written');
  assert.equal((await call('GET', '/api/mission-titles/model')).status, 401);
  assert.equal((await call('PUT', '/api/mission-titles/model', { body: { value: 'off' } })).status, 401);
  const operator = await call('GET', '/api/mission-titles/model', { bearer: TOKEN });
  assert.equal(operator.status, 200);
  assert.equal(operator.json.value, null);
  assert.equal((await call('PUT', '/api/mission-titles/model', { bearer: TOKEN, body: { value: 'off' } })).status, 403);
});
