/**
 * `GET /api/skills/:id/file` (TODO #674): a file next to a Timon skill's
 * SKILL.md, for an agent that cannot open Timon's disk. Refused to an anonymous
 * caller, and never a path out of the skill folder. Isolated TIMON_HOME,
 * witness on 127.0.0.1:0.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const SANDBOX = mkdtempSync(join(tmpdir(), 'timon-skill-files-'));
process.env.TIMON_HOME = join(SANDBOX, 'home');
mkdirSync(process.env.TIMON_HOME, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, 'claude');
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgents } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SKILLS_DIR } = await import('../../paths.js');
const { upsertSkill } = await import('../../skills.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgents(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

async function get(path: string, bearer?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { text }; }
  return { status: res.status, json };
}

upsertSkill('ref-skill', '---\nname: ref-skill\ndescription: Cites a reference.\n---\n\nSee references/api.md.\n');
mkdirSync(join(SKILLS_DIR, 'ref-skill', 'references'), { recursive: true });
writeFileSync(join(SKILLS_DIR, 'ref-skill', 'references', 'api.md'), 'API REFERENCE\n');
writeFileSync(join(SKILLS_DIR, 'ref-skill', '.env'), 'SECRET=1\n');
upsertSkill('other-skill', '---\nname: other-skill\ndescription: Another.\n---\n\nOTHER BODY\n');
writeFileSync(join(SKILLS_DIR, 'secret-at-root.md'), 'ROOT SECRET\n');

const FILE = '/api/skills/ref-skill/file?path=references%2Fapi.md';

test('an anonymous caller is refused, and learns nothing of the file', async () => {
  const r = await get(FILE);
  assert.equal(r.status, 401);
  assert.ok(!JSON.stringify(r.json).includes('API REFERENCE'));
});

test('an authenticated caller reads a file of the skill folder', async () => {
  const r = await get(FILE, TOKEN);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { id: 'ref-skill', path: 'references/api.md', content: 'API REFERENCE\n' });
});

test('a mission reads it with its own token, as `skill_get` does', async () => {
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', name: 'Admin', password: 'admin-secret' }),
  });
  assert.equal(setup.status, 201);
  const owner = dbApi.listUsers()[0]!.id;
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'reader.agent', 'work', undefined, owner);
  const r = await get(FILE, issueMissionApiToken(missionId));
  assert.equal(r.status, 200);
  assert.equal(r.json.content, 'API REFERENCE\n');
});

test('no path leaves the skill folder', async () => {
  for (const [path, status] of [
    ['..%2Fother-skill%2FSKILL.md', 400],
    ['..%2Fsecret-at-root.md', 400],
    ['references%2F..%2F..%2Fsecret-at-root.md', 400],
    ['%2Fetc%2Fpasswd', 400],
    ['..%5Csecret-at-root.md', 400],
    ['.env', 400],
    ['SKILL.md', 400],
    ['absent.md', 404],
  ] as const) {
    const r = await get(`/api/skills/ref-skill/file?path=${path}`, TOKEN);
    assert.equal(r.status, status, path);
    assert.ok(!JSON.stringify(r.json).includes('SECRET'), path);
  }
  assert.equal((await get('/api/skills/ref-skill/file', TOKEN)).status, 400, 'path required');
  assert.equal((await get('/api/skills/ref-skill/file?path=a&path=b', TOKEN)).status, 400, 'one path, never a list');
  assert.equal((await get('/api/skills/..%2F/file?path=secret-at-root.md', TOKEN)).status, 400, 'an id naming the parent');
});

// A name only a POSIX disk can hold: Windows reads `:` as a stream, `\` as a separator.
test('GET /api/skills/:id does not offer a name the file route refuses', { skip: process.platform === 'win32' }, async () => {
  upsertSkill('odd-skill', '---\nname: odd-skill\ndescription: Odd names.\n---\n\nODD BODY\n');
  writeFileSync(join(SKILLS_DIR, 'odd-skill', 'good.md'), 'GOOD\n');
  writeFileSync(join(SKILLS_DIR, 'odd-skill', 'notes:v2.md'), 'COLON\n');
  writeFileSync(join(SKILLS_DIR, 'odd-skill', 'back\\slash.md'), 'BACKSLASH\n');
  const r = await get('/api/skills/odd-skill', TOKEN);
  assert.deepEqual(r.json.files, [{ path: 'good.md', size: 'GOOD\n'.length }]);
  for (const path of ['notes%3Av2.md', 'back%5Cslash.md']) {
    const refused = await get(`/api/skills/odd-skill/file?path=${path}`, TOKEN);
    assert.equal(refused.status, 400, path);
    assert.ok(!JSON.stringify(refused.json).includes('COLON') && !JSON.stringify(refused.json).includes('BACKSLASH'), path);
  }
});

test('GET /api/skills/:id names the files next to a Timon skill, dot entries left out', async () => {
  const r = await get('/api/skills/ref-skill', TOKEN);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.files, [{ path: 'references/api.md', size: 'API REFERENCE\n'.length }]);
  const other = await get('/api/skills/other-skill', TOKEN);
  assert.deepEqual(other.json.files, []);
});
