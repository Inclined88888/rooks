/**
 * A conversion mission's Allow/Deny cards (TODO #469, #471): a shell, write, edit, fetch or file-read
 * card, and the card of any MCP server that is not Rooks's, is denied before any card exists, even
 * for a developer-owner whose missions are otherwise auto-allowed, and nothing of that mission is
 * ever auto-allowed. An ordinary mission of the same owner keeps the auto-allow.
 *
 * Witness app: the real auth middleware and the real permission route.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi } from '../db.js';
import { issueMissionApiToken } from './api-tokens.js';
import { conversionToolCardRefusal } from './conversion-mission.js';
import { createDaemonAuthMiddleware } from '../plugins-bundled/http/auth.js';
import { registerRoutes as registerMissionRoutes } from '../plugins-bundled/missions/routes.js';
import { listPending } from '../permissions.js';
import { licenseState, setLicenseState } from '../license/runtime.js';

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

// A verified developer account: superadmin on the internal plan, whose missions skip their cards.
const original = licenseState();
setLicenseState({
  ...original, status: 'valid', reason: null, planId: 'internal', modules: '*', plugins: '*', users: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});
const dev = createTestAccount(dbApi, { email: 'conv-dev@example.test', name: 'Dev', passwordHash: 'unused', isSuperadmin: true });

const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'conversion-cards-daemon' }));
app.use(express.json());
registerMissionRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => { server.close(); setLicenseState(original); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function mission(source?: { channel: string; meta?: unknown }): { token: string; missionId: string } {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'dev.agent', 'learn', source, dev.id);
  return { token: issueMissionApiToken(missionId), missionId };
}
const conversion = () => mission({ channel: 'chat', meta: { browser_recording_id: 'br-00000000-0000-4000-8000-000000000469' } });

async function card(token: string, missionId: string, toolName: string, signal?: AbortSignal) {
  const res = await fetch(`${base}/api/permissions/request`, {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ mission_id: missionId, tool_name: toolName, tool_use_id: `${toolName}_${randomUUID()}`, input: { command: 'cat ~/.rooks/daemon-token' } }),
  });
  return { status: res.status, json: await res.json() as { behavior?: string; message?: string } };
}

const events = (missionId: string, type: string) => dbApi.listEvents(missionId).filter((event) => event.type === type);

const BUILT_INS = ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'Read', 'Glob', 'Grep', 'LS', 'a_tool_nobody_listed'];
// An account connector and the project's index answer outside the daemon: no route list bounds them.
const FOREIGN_MCP = ['mcp__claude_ai_Notes__semantic_search', 'mcp__claude_ai_Notes__write_note', 'mcp__claude_ai_Gmail__send_email', 'mcp__grepai__grepai_search'];

test('a shell, write, edit, fetch or file-read card of a conversion is denied at once, the developer-owner notwithstanding', async () => {
  const { token, missionId } = conversion();
  for (const tool of BUILT_INS) {
    const answer = await card(token, missionId, tool);
    assert.equal(answer.status, 200, tool);
    assert.equal(answer.json.behavior, 'deny', tool);
    assert.match(answer.json.message ?? '', /runs no shell and reads or writes no file/, tool);
  }
  assert.equal(listPending(missionId).length, 0, 'no card reached anybody');
  assert.equal(events(missionId, 'permission_dev_allowed').length, 0);
  assert.equal(events(missionId, 'permission_conversion_denied').length, BUILT_INS.length);
});

test('the card of an MCP server that is not Rooks\'s is denied at once, the notes connector included', async () => {
  const { token, missionId } = conversion();
  for (const tool of FOREIGN_MCP) {
    const answer = await card(token, missionId, tool);
    assert.equal(answer.json.behavior, 'deny', tool);
    assert.match(answer.json.message ?? '', /calls Rooks's own tools only/, tool);
  }
  assert.equal(listPending(missionId).length, 0, 'no card reached anybody');
  assert.equal(events(missionId, 'permission_dev_allowed').length, 0);
});

test('a card for one of Rooks\'s own tools opens for a person instead of being auto-allowed', async () => {
  const { token, missionId } = conversion();
  const waiting = new AbortController();
  const asked = card(token, missionId, 'mcp__rooks__skill_put', waiting.signal).catch(() => null);
  try {
    for (let i = 0; i < 100 && !listPending(missionId).length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(listPending(missionId).length, 1, 'the card waits for a person');
    assert.equal(events(missionId, 'permission_dev_allowed').length, 0);
  } finally {
    // The route holds the request open until someone answers: the shim giving up closes it.
    waiting.abort();
    await asked;
  }
});

test('an ordinary mission of the same developer keeps its auto-allow', async () => {
  const { token, missionId } = mission();
  const answer = await card(token, missionId, 'Bash');
  assert.equal(answer.json.behavior, 'allow');
  assert.equal(events(missionId, 'permission_dev_allowed').length, 1);
});

test('the card rule is closed by default: forms and Rooks\'s own MCP tools only', () => {
  for (const tool of ['ask_user', 'mcp__rooks__skill_put', 'mcp__rooks-browser__take_snapshot', 'mcp__rooks-browser__navigate_page',
    'mcp__rooks_ask__question', 'mcp__rooks_permission__ask_user']) {
    assert.equal(conversionToolCardRefusal(tool), null, tool);
  }
  for (const tool of ['Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'WebSearch', 'Task', 'read', 'mcp_fake',
    'Read', 'Glob', 'Grep', 'LS', ...FOREIGN_MCP, 'mcp__rooks', 'mcp__rooks__', 'mcp__fakex__skill_put', 'mcp__evil__mcp__rooks__skill_put',
    'mcp__chrome-devtools__navigate_page']) {
    assert.ok(conversionToolCardRefusal(tool), tool);
  }
});
