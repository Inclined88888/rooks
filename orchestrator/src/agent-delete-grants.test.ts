/**
 * TODO #668 — what a deleted agent was granted (secrets, browser profile
 * allowlists) and its own browser profiles must not reach an agent recreated
 * under the same name. Grants are revoked for good; the own profile is parked
 * with the trash entry, back with a restore, gone with a purge.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-agent-delete-grants-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
delete process.env.TIMON_AGENT_TRASH_ENABLED;
delete process.env.TIMON_AGENT_TRASH_RETENTION_DAYS;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

await import('../tests/helpers/claude-provider.js');
const { createEphemeralAgent, deleteAgent, restoreAgent, upsertAgent } = await import('./agent.js');
const { listAgentTrash, trashAgentDir } = await import('./agent-trash.js');
const { db, dbApi } = await import('./db.js');
const { resolveSecretsFor } = await import('./secrets/resolve.js');
const {
  browserProfileAllows, createBrowserProfile, getBrowserProfile, resolveBrowserProfile, TRASHED_AGENT_PROFILE_PREFIX,
} = await import('./browser-profiles.js');
const { sweepDeletedAgentGrants } = await import('./agent-grants-migration.js');
const { browserProfileDir } = await import('./paths.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes } = await import('./plugins-bundled/agents/routes.js');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

function seed(name: string): void {
  upsertAgent({ name, system_prompt: `prompt of ${name}`, config: { role: 'coder' } });
}

let secretSeq = 0;
function secret(name: string, grants: Array<[string, string | null]>): string {
  const id = `s-${++secretSeq}`;
  const now = Date.now();
  db.prepare(`INSERT INTO secrets (id, name, value_enc, mode, created_at, updated_at) VALUES (?, ?, 'sealed', 'inject', ?, ?)`).run(id, name, now, now);
  for (const [kind, ref] of grants) dbApi.addSecretGrant(id, kind as 'agent', ref);
  return id;
}

function injected(agent: string): string[] {
  return resolveSecretsFor({ agent, project: null, secrets: dbApi.listSecrets() }).map((s) => s.name);
}

function ownProfile(agent: string): string {
  const p = createBrowserProfile({ name: `browser of ${agent}`, owner_user_id: null, scope_kind: 'agent', scope_ref: agent });
  // What the desktop keeps under the same home: cookies of a signed-in session.
  mkdirSync(join(browserProfileDir(p.id), 'electron'), { recursive: true });
  writeFileSync(join(browserProfileDir(p.id), 'electron', 'Cookies'), 'session');
  return p.id;
}

function agentProfileOf(agent: string): string | null {
  return resolveBrowserProfile({ ownerUserId: null, agentName: agent })?.id ?? null;
}

test('a homonym recreated after a deletion gets none of the old secrets nor its browser', () => {
  seed('alpha');
  secret('ALPHA_TOKEN', [['agent', 'alpha']]);
  secret('SHARED_TOKEN', [['agent', 'alpha'], ['agent', 'beta']]);
  secret('EVERYONE', [['global', null]]);
  const own = ownProfile('alpha');
  const listed = createBrowserProfile({ name: 'shared', owner_user_id: null, scope_kind: 'custom', grants: { agent_names: ['alpha', 'beta'] } });
  const onlyAlpha = createBrowserProfile({ name: 'alpha only', owner_user_id: null, scope_kind: 'custom', grants: { agent_names: ['alpha'] } });
  assert.deepEqual(injected('alpha'), ['ALPHA_TOKEN', 'EVERYONE', 'SHARED_TOKEN'], 'witness: granted before the deletion');
  assert.equal(agentProfileOf('alpha'), own);

  assert.equal(deleteAgent('alpha'), true);
  seed('alpha');

  assert.deepEqual(injected('alpha'), ['EVERYONE'], 'the homonym is refused what the old agent was granted');
  assert.deepEqual(injected('beta'), ['EVERYONE', 'SHARED_TOKEN'], 'another agent keeps its own grant');
  assert.notEqual(agentProfileOf('alpha'), own, 'the homonym does not open the old signed-in browser');
  const ownRow = getBrowserProfile(own);
  assert.ok(ownRow);
  assert.match(String(ownRow.scope_ref), /^trash:\d{8}-\d{9}-alpha$/);
  assert.equal(browserProfileAllows(ownRow, { ownerUserId: null, agentName: 'alpha' }), false);
  assert.ok(existsSync(join(browserProfileDir(own), 'electron', 'Cookies')), 'parked, not erased: the trash can bring it back');

  const shared = getBrowserProfile(listed.id);
  assert.ok(shared);
  assert.deepEqual(shared.grants.agent_names, ['beta']);
  assert.equal(browserProfileAllows(shared, { ownerUserId: null, agentName: 'alpha' }), false);
  assert.equal(browserProfileAllows(shared, { ownerUserId: null, agentName: 'beta' }), true);
  const emptied = getBrowserProfile(onlyAlpha.id);
  assert.ok(emptied);
  assert.deepEqual(emptied.grants.agent_names, [], 'the allowlist stays, emptied: it does not open to everyone');
  assert.equal(browserProfileAllows(emptied, { ownerUserId: null, agentName: 'alpha' }), false);
  assert.equal(browserProfileAllows(emptied, { ownerUserId: null, agentName: 'gamma' }), false);
});

test('a restore brings the agent\'s own browser back, not its secret grants', () => {
  const own = db.prepare(`SELECT id FROM browser_profiles WHERE scope_ref LIKE 'trash:%alpha'`).get() as { id: string };
  // The homonym leaves for good so the trashed one can come back under its name.
  deleteAgent('alpha', { purge: true });
  const entry = listAgentTrash().find((e) => e.name === 'alpha');
  assert.ok(entry);
  const r = restoreAgent(entry.id);
  assert.equal(r.ok, true);
  assert.equal(agentProfileOf('alpha'), own.id, 'its signed-in browser is back');
  assert.deepEqual(injected('alpha'), ['EVERYONE'], 'secrets need the user to grant them again');
});

test('a deletion that keeps nothing deletes the own profile and its stored session', () => {
  seed('gone');
  const own = ownProfile('gone');
  secret('GONE_TOKEN', [['agent', 'gone']]);
  deleteAgent('gone', { purge: true });
  assert.equal(getBrowserProfile(own), null);
  assert.equal(existsSync(browserProfileDir(own)), false);
  seed('gone');
  assert.deepEqual(injected('gone'), ['EVERYONE']);
  assert.notEqual(agentProfileOf('gone'), own);
});

test('an ephemeral agent gives its grants back too', () => {
  const name = createEphemeralAgent({ system_prompt: 'scratch' }).name;
  secret('SCRATCH_TOKEN', [['agent', name]]);
  deleteAgent(name);
  assert.deepEqual(dbApi.listSecretGrantAgents().filter((n) => n === name), []);
});

test('purging a trash entry deletes its parked profile; an anonymous purge is refused and touches nothing', async () => {
  seed('purged');
  const own = ownProfile('purged');
  const del = await fetch(`${base}/api/agents/purged`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(del.status, 200);
  const id = String(((await del.json()) as { trash_id?: unknown }).trash_id);
  assert.equal(getBrowserProfile(own)?.scope_ref, `${TRASHED_AGENT_PROFILE_PREFIX}${id}`);

  const anon = await fetch(`${base}/api/agent-trash/${encodeURIComponent(id)}`, { method: 'DELETE' });
  assert.equal(anon.status, 401);
  assert.ok(getBrowserProfile(own), 'an anonymous caller deletes nothing');

  const purge = await fetch(`${base}/api/agent-trash/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(purge.status, 200);
  assert.equal(getBrowserProfile(own), null);
  assert.equal(existsSync(browserProfileDir(own)), false);
});

test('the boot sweep settles agents deleted before the fix', () => {
  seed('beta');
  // As a deletion did before TODO #668: the folder left, the grants stayed.
  seed('legacy');
  secret('LEGACY_TOKEN', [['agent', 'legacy']]);
  const parked = ownProfile('legacy');
  const legacyEntry = trashAgentDir('legacy');
  secret('GHOST_TOKEN', [['agent', 'ghost'], ['agent', 'plugin:acme']]);
  const ghostProfile = ownProfile('ghost');
  const allow = createBrowserProfile({ name: 'ghost list', owner_user_id: null, scope_kind: 'custom', grants: { agent_names: ['ghost', 'beta'] } });
  seed('living');
  secret('LIVING_TOKEN', [['agent', 'living']]);
  const living = ownProfile('living');
  const orphan = ownProfile('orphan');
  db.prepare('UPDATE browser_profiles SET scope_ref = ? WHERE id = ?').run(`${TRASHED_AGENT_PROFILE_PREFIX}20200101-000000000-orphan`, orphan);

  const out = sweepDeletedAgentGrants();
  assert.equal(out.secretGrants, 2, 'legacy and ghost');
  assert.equal(out.parked, 1);
  assert.equal(out.dropped, 2, 'ghost has no trash entry, orphan lost its own');

  seed('legacy');
  seed('ghost');
  assert.deepEqual(injected('legacy'), ['EVERYONE']);
  assert.deepEqual(injected('ghost'), ['EVERYONE']);
  assert.ok(dbApi.listSecretGrantAgents().includes('plugin:acme'), 'a plugin address is not an agent name');
  assert.deepEqual(injected('living'), ['EVERYONE', 'LIVING_TOKEN'], 'a living agent keeps its grants');
  assert.equal(getBrowserProfile(parked)?.scope_ref, `${TRASHED_AGENT_PROFILE_PREFIX}${legacyEntry.id}`);
  assert.equal(getBrowserProfile(ghostProfile), null);
  assert.equal(getBrowserProfile(orphan), null);
  assert.equal(getBrowserProfile(living)?.scope_ref, 'living');
  assert.deepEqual(getBrowserProfile(allow.id)?.grants.agent_names, ['beta']);

  assert.deepEqual(sweepDeletedAgentGrants(), { secretGrants: 0, allowlists: 0, parked: 0, dropped: 0 }, 'idempotent');
});
