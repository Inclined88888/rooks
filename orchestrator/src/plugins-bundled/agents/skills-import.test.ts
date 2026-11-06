/**
 * `POST /api/skills/:id/import`: a `claude-user` or `plugin` skill, invisible to
 * missions, copied into the Timon skills folder. Isolated TIMON_HOME and Claude
 * config dir, witness on 127.0.0.1:0.
 */
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

const SANDBOX = mkdtempSync(join(tmpdir(), 'timon-skills-import-'));
process.env.TIMON_HOME = join(SANDBOX, 'home');
mkdirSync(process.env.TIMON_HOME, { recursive: true });
// Read once by the registry when it loads: the operator's own ~/.claude stays out of this test.
const CLAUDE = join(SANDBOX, 'claude');
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgents } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SKILLS_DIR, skillFile } = await import('../../paths.js');
const { IMPORT_MAX_FILES } = await import('../../skill-registry.js');
const { hashApiToken, issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

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

type Auth = { cookie?: string; bearer?: string };

async function call(method: string, path: string, opts: Auth & { body?: unknown } = {}): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

function sessionCookie(res: Response): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function createUser(email: string, permissions: string[]): Promise<{ id: string; cookie: string }> {
  const password = `${email}-secret`;
  const created = await postTestAccount(dbApi, { email, name: email, password });
  assert.equal(created.status, 201);
  const id = (created.json as { user: { id: string } }).user.id;
  grantTestPermissions(dbApi, id, permissions);
  const login = await call('POST', '/api/auth/login', { body: { email, password } });
  const cookie = sessionCookie(login.res)!;
  assert.ok(cookie);
  return { id, cookie };
}

function missionToken(agent: string, ownerId: string): string {
  const missionId = randomUUID();
  dbApi.createMission(missionId, agent, 'work', undefined, ownerId);
  const raw = issueMissionApiToken(missionId);
  assert.ok(dbApi.getLiveApiToken(hashApiToken(raw)));
  return raw;
}

function reasonOf(json: unknown): string {
  return String((json as { reason?: unknown } | null)?.reason ?? '');
}

function codeOf(json: unknown): string {
  return String((json as { code?: unknown } | null)?.code ?? '');
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup.res)!;
const bob = await createUser('bob@example.com', ['skills:manage', 'agents:manage', 'missions:read']);
const carol = await createUser('carol@example.com', ['skills:manage', 'agents:manage', 'agents:privileged-config']);
const ada = await createUser('ada@example.com', ['missions:read']);
const adaToken = missionToken('ada.agent', ada.id);

/* ── what the operator has in ~/.claude ─────────────────────────────────── */

const SKILL = '---\nname: Helper\ndescription: Helps.\n---\n\n# Helper\n\nDo the thing.\n';
const WITH_TOOLS = '---\nname: tooled\nallowed-tools: Bash\n---\n\n# tooled\n';

function userSkill(id: string, content: string): string {
  const dir = join(CLAUDE, 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
  return dir;
}

const helperDir = userSkill('helper', SKILL);
mkdirSync(join(helperDir, 'scripts'), { recursive: true });
writeFileSync(join(helperDir, 'scripts', 'run.sh'), 'echo run\n');
mkdirSync(join(helperDir, '.git'), { recursive: true });
writeFileSync(join(helperDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
const SECRET = join(SANDBOX, 'secret.txt');
writeFileSync(SECRET, 'not for the skills folder\n');
// A link would reach out of the skills folder once copied: it is skipped, never followed.
// A file link needs a privilege on Windows (developer mode): without it, that case is not exercised.
let linked = true;
try { symlinkSync(SECRET, join(helperDir, 'leak.txt'), 'file'); } catch { linked = false; }

userSkill('tooled', WITH_TOOLS);
mkdirSync(join(CLAUDE, 'commands'), { recursive: true });
writeFileSync(join(CLAUDE, 'commands', 'deploy.md'), '# Deploy\n\nShip it.\n');
const hugeDir = userSkill('huge', SKILL);
for (let i = 0; i < IMPORT_MAX_FILES + 1; i += 1) writeFileSync(join(hugeDir, `f${i}.md`), 'x');

// A plugin with a skill, a hook and an MCP server: only the skill is imported.
const pluginRoot = join(CLAUDE, 'plugins', 'cache', 'market', 'myplug', '1.0.0');
mkdirSync(join(pluginRoot, 'skills', 'review'), { recursive: true });
writeFileSync(join(pluginRoot, 'skills', 'review', 'SKILL.md'), '# Review\n\nReview the diff.\n');
mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
writeFileSync(join(pluginRoot, 'hooks', 'hooks.json'), '{"hooks":{}}');
writeFileSync(join(pluginRoot, '.mcp.json'), '{"mcpServers":{}}');
writeFileSync(join(CLAUDE, 'plugins', 'installed_plugins.json'), JSON.stringify({
  plugins: { 'myplug@market': [{ installPath: pluginRoot }] },
}));

// A root `skill.md` beside SKILL.md. On macOS and Windows it is SKILL.md itself:
// the hard link reproduces what their readdir hands back (a second name for the
// entry), the distinct file what only a case-sensitive volume can hold.
const twinDir = userSkill('twin', SKILL);
try { linkSync(join(twinDir, 'SKILL.md'), join(twinDir, 'skill.md')); } catch { /* case-insensitive: one name only */ }
const LOWER = '# lowercase twin\n';
const lowerDir = userSkill('lower', SKILL);
writeFileSync(join(lowerDir, 'skill.md'), LOWER);
const caseInsensitive = readFileSync(join(lowerDir, 'SKILL.md'), 'utf8') === LOWER;

/* ── access ─────────────────────────────────────────────────────────────── */

test('anonymous is 401 and nothing is copied', async () => {
  const r = await call('POST', '/api/skills/helper/import', { body: { source: 'claude-user' } });
  assert.equal(r.status, 401);
  assert.equal(existsSync(skillFile('helper')), false);
});

test('a caller without skills:manage is refused, by session and by mission token', async () => {
  for (const auth of [{ cookie: ada.cookie }, { bearer: adaToken }]) {
    const r = await call('POST', '/api/skills/helper/import', { ...auth, body: { source: 'claude-user' } });
    assert.equal(r.status, 403, JSON.stringify(auth));
  }
  assert.equal(existsSync(skillFile('helper')), false);
});

/* ── the copy ───────────────────────────────────────────────────────────── */

test('a holder of skills:manage imports a skill folder: files copied, link and .git left out', async () => {
  const r = await call('POST', '/api/skills/helper/import', { cookie: bob.cookie, body: { source: 'claude-user' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const body = r.json as { id: string; path: string; files: number; skipped: string[] };
  assert.equal(body.id, 'helper');
  assert.equal(body.path, skillFile('helper'));
  assert.equal(readFileSync(skillFile('helper'), 'utf8'), SKILL);
  assert.equal(readFileSync(join(SKILLS_DIR, 'helper', 'scripts', 'run.sh'), 'utf8'), 'echo run\n');
  assert.equal(existsSync(join(SKILLS_DIR, 'helper', 'leak.txt')), false);
  assert.equal(existsSync(join(SKILLS_DIR, 'helper', '.git')), false);
  assert.deepEqual([...body.skipped].sort(), linked ? ['.git', 'leak.txt'] : ['.git']);
  // The source is untouched, and the copy is a Timon skill.
  assert.equal(readFileSync(join(helperDir, 'SKILL.md'), 'utf8'), SKILL);
  const listed = await call('GET', '/api/skills', { cookie: bob.cookie });
  const sources = (listed.json as { skills: { id: string; source: string; shadowed?: boolean }[] }).skills
    .filter((s) => s.id === 'helper');
  assert.deepEqual(sources.map((s) => [s.source, !!s.shadowed]).sort(), [['claude-user', true], ['timon', false]]);
});

test('a masked skill is read by its source; the bare id reads the winner', async () => {
  // `helper` now lives in the Timon folder (winner) and in ~/.claude (masked).
  assert.equal((await call('GET', '/api/skills/helper?source=claude-user')).status, 401, 'anonymous');
  const winner = await call('GET', '/api/skills/helper', { cookie: bob.cookie });
  assert.equal((winner.json as { source: string }).source, 'timon');
  const masked = await call('GET', '/api/skills/helper?source=claude-user&format=claude-skill', { cookie: bob.cookie });
  assert.equal(masked.status, 200, JSON.stringify(masked.json));
  const body = masked.json as { source: string; path: string; content: string; shadowed?: boolean };
  assert.equal(body.source, 'claude-user');
  assert.equal(body.path, join(helperDir, 'SKILL.md'));
  assert.equal(body.shadowed, true);
  assert.equal(body.content, SKILL);
  assert.equal((await call('GET', '/api/skills/helper?source=project', { cookie: bob.cookie })).status, 404, 'no entry of that source');
  assert.equal((await call('GET', '/api/skills/helper?source=claude-user&format=claude-cmd', { cookie: bob.cookie })).status, 404);
  assert.equal((await call('GET', '/api/skills/helper?source=..%2Fsecret', { cookie: bob.cookie })).status, 400);
  assert.equal((await call('GET', '/api/skills/helper?format=claude-skill', { cookie: bob.cookie })).status, 400, 'a format needs its source');
});

test('a root skill.md, any case, never collides with the SKILL.md write', async () => {
  const onlyEntry = (id: string) => readdirSync(join(SKILLS_DIR, id)).filter((n) => n.toLowerCase() === 'skill.md');

  const twin = await call('POST', '/api/skills/twin/import', { cookie: bob.cookie, body: { source: 'claude-user' } });
  assert.equal(twin.status, 201, JSON.stringify(twin.json));
  assert.deepEqual((twin.json as { skipped: string[] }).skipped, []);
  assert.deepEqual(onlyEntry('twin'), ['SKILL.md']);
  assert.equal(readFileSync(skillFile('twin'), 'utf8'), SKILL);

  const lower = await call('POST', '/api/skills/lower/import', { cookie: bob.cookie, body: { source: 'claude-user' } });
  assert.equal(lower.status, 201, JSON.stringify(lower.json));
  assert.deepEqual((lower.json as { skipped: string[] }).skipped, caseInsensitive ? [] : ['skill.md']);
  assert.deepEqual(onlyEntry('lower'), ['SKILL.md']);
  assert.equal(readFileSync(skillFile('lower'), 'utf8'), caseInsensitive ? LOWER : SKILL);
});

test('an id collision is refused with 409 and the stored skill untouched; another id imports', async () => {
  writeFileSync(skillFile('helper'), '# edited in Timon\n');
  const again = await call('POST', '/api/skills/helper/import', { cookie: adminCookie, body: { source: 'claude-user' } });
  assert.equal(again.status, 409);
  assert.equal(codeOf(again.json), 'skill_exists');
  assert.equal(readFileSync(skillFile('helper'), 'utf8'), '# edited in Timon\n');

  const renamed = await call('POST', '/api/skills/helper/import', { cookie: bob.cookie, body: { source: 'claude-user', as: 'helper-2' } });
  assert.equal(renamed.status, 201);
  assert.equal(readFileSync(skillFile('helper-2'), 'utf8'), SKILL);
});

test('a product skill id is never an import target', async () => {
  const r = await call('POST', '/api/skills/helper/import', { cookie: adminCookie, body: { source: 'claude-user', as: 'timon-task' } });
  assert.equal(r.status, 409);
  assert.equal(codeOf(r.json), 'skill_exists');
});

test('a plugin skill is imported alone, under its namespace folded into the id', async () => {
  const r = await call('POST', `/api/skills/${encodeURIComponent('myplug:review')}/import`, { cookie: bob.cookie, body: { source: 'plugin' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((r.json as { id: string }).id, 'myplug-review');
  assert.deepEqual(readdirSync(join(SKILLS_DIR, 'myplug-review')), ['SKILL.md']);
  assert.equal(existsSync(join(SKILLS_DIR, 'hooks')), false);
});

test('a slash command becomes the SKILL.md of a new folder', async () => {
  const r = await call('POST', '/api/skills/deploy/import', { cookie: bob.cookie, body: { source: 'claude-user' } });
  assert.equal(r.status, 201);
  assert.equal(readFileSync(skillFile('deploy'), 'utf8'), '# Deploy\n\nShip it.\n');
});

test('a skill that pre-authorises tools needs agents:privileged-config', async () => {
  const refused = await call('POST', '/api/skills/tooled/import', { cookie: bob.cookie, body: { source: 'claude-user' } });
  assert.equal(refused.status, 403);
  assert.match(reasonOf(refused.json), /agents:privileged-config/);
  assert.equal(existsSync(join(SKILLS_DIR, 'tooled')), false);

  const allowed = await call('POST', '/api/skills/tooled/import', { cookie: carol.cookie, body: { source: 'claude-user' } });
  assert.equal(allowed.status, 201);
  assert.equal(readFileSync(skillFile('tooled'), 'utf8'), WITH_TOOLS);
});

test('a folder over the import limits is refused and nothing is created', async () => {
  const r = await call('POST', '/api/skills/huge/import', { cookie: adminCookie, body: { source: 'claude-user' } });
  assert.equal(r.status, 413);
  assert.equal(codeOf(r.json), 'too_large');
  assert.equal(existsSync(join(SKILLS_DIR, 'huge')), false);
});

test('bad input: unknown skill 404, wrong source or id 400, never a path', async () => {
  assert.equal((await call('POST', '/api/skills/nope/import', { cookie: bob.cookie, body: { source: 'claude-user' } })).status, 404);
  // Right id, wrong source: the registry is asked for that pair only.
  assert.equal((await call('POST', '/api/skills/helper/import', { cookie: bob.cookie, body: { source: 'plugin' } })).status, 404);
  for (const source of ['timon', 'project', undefined]) {
    assert.equal((await call('POST', '/api/skills/helper/import', { cookie: bob.cookie, body: { source } })).status, 400, String(source));
  }
  for (const as of ['../escape', 'UPPER', 'trailing.', '.hidden', 'a/b', 'a\\b']) {
    const r = await call('POST', '/api/skills/helper/import', { cookie: bob.cookie, body: { source: 'claude-user', as } });
    assert.equal(r.status, 400, as);
  }
  assert.equal((await call('POST', '/api/skills/helper/import', {
    cookie: bob.cookie, body: { source: 'claude-user', path: join(SANDBOX, 'secret.txt') },
  })).status, 400);
  assert.equal(existsSync(join(SANDBOX, 'home', 'escape')), false);
});
