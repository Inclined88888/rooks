/**
 * A skill read with a mission token has its vault values masked (TODO #731):
 * the token goes to an agent, and a backend with the MCP but no disk would
 * otherwise fetch the value through `skill_get`. The editor's session keeps the
 * raw text, or a save would overwrite the secret with `***`; and a mission cannot
 * write the masked text back. Isolated ROOKS_HOME, witness on 127.0.0.1:0.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const SANDBOX = mkdtempSync(join(tmpdir(), 'rooks-skill-masking-'));
process.env.ROOKS_HOME = join(SANDBOX, 'home');
mkdirSync(process.env.ROOKS_HOME, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, 'claude');
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.ROOKS_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgents } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SKILLS_DIR, skillFile } = await import('../../paths.js');
const { upsertSkill } = await import('../../skills.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { seal } = await import('../../secrets/box.js');
const { resolveMasterKey } = await import('../../secrets/key.js');

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
type Reply = { status: number; json: Record<string, unknown>; text: string };

async function call(method: string, path: string, auth: Auth = {}, body?: unknown): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(auth.cookie)}`;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = {}; }
  return { status: res.status, json, text };
}

function sessionCookie(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error('no session cookie');
}

const setup = await fetch(`${base}/api/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', name: 'Admin', password: 'admin-secret' }),
});
assert.equal(setup.status, 201);
const session: Auth = { cookie: sessionCookie(setup) };
const owner = dbApi.listUsers()[0]!.id;
const mission: Auth = (() => {
  const id = randomUUID();
  dbApi.createMission(id, 'reader.agent', 'work', undefined, owner);
  return { bearer: issueMissionApiToken(id) };
})();
const operator: Auth = { bearer: TOKEN };

const VALUE = 'vault-route-value-0123456789';
const secretId = randomUUID();
dbApi.createSecret({ id: secretId, name: 'ROUTE_TOKEN', value_enc: seal(VALUE, resolveMasterKey(), { secretId, name: 'ROUTE_TOKEN' }), mode: 'inject' });

const SKILL = `---\nname: vault-skill\ndescription: Holds ${VALUE} too.\n---\n\nBODY KEEP token=${VALUE}\n`;
upsertSkill('vault-skill', SKILL);
mkdirSync(join(SKILLS_DIR, 'vault-skill', 'references'), { recursive: true });
writeFileSync(join(SKILLS_DIR, 'vault-skill', 'references', 'config.md'), `FILE KEEP key=${VALUE}\n`);
writeFileSync(join(SKILLS_DIR, 'vault-skill', `notes-${VALUE}.md`), 'NAMED FILE\n');

const BODY = '/api/skills/vault-skill';
const FILE = `${BODY}/file?path=references%2Fconfig.md`;

test('anonymous is refused on the three reads, and learns nothing of the skill', async () => {
  for (const path of ['/api/skills', BODY, FILE]) {
    const r = await call('GET', path);
    assert.equal(r.status, 401, path);
    assert.ok(!r.text.includes(VALUE) && !r.text.includes('KEEP'), path);
  }
});

test('a mission token reads the body with its vault values masked, in every field', async () => {
  const r = await call('GET', BODY, mission);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(VALUE), 'nowhere in the answer: body, description, file names');
  assert.match(r.json.content as string, /BODY KEEP token=\*\*\*/);
  assert.match(r.json.description as string, /Holds \*\*\* too\./);
  assert.ok((r.json.files as { path: string }[]).some((f) => f.path === 'notes-***.md'));
  assert.ok((r.json.files as { path: string }[]).some((f) => f.path === 'references/config.md'), 'a clean name is usable as it is');
});

test('a mission token reads a neighbour file with its vault values masked', async () => {
  const r = await call('GET', FILE, mission);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(VALUE));
  assert.equal(r.json.content, 'FILE KEEP key=***\n');
});

test('a mission token lists the skills with their vault values masked', async () => {
  const r = await call('GET', '/api/skills', mission);
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(VALUE));
  const entry = (r.json.skills as { id: string; description: string }[]).find((s) => s.id === 'vault-skill')!;
  assert.match(entry.description, /Holds \*\*\* too\./);
});

test('the editor\'s session and the operator keep the raw text: a save would write `***` otherwise', async () => {
  for (const [who, auth] of [['session', session], ['operator', operator]] as const) {
    const body = await call('GET', BODY, auth);
    assert.equal(body.status, 200, who);
    assert.equal(body.json.content, SKILL, who);
    const file = await call('GET', FILE, auth);
    assert.equal(file.json.content, `FILE KEEP key=${VALUE}\n`, who);
    const list = await call('GET', '/api/skills', auth);
    assert.ok(list.text.includes(VALUE), who);
  }
});

test('a mission cannot write the masked text back over the values it replaced', async () => {
  const masked = (await call('GET', BODY, mission)).json.content as string;
  const r = await call('POST', '/api/skills', mission, { id: 'vault-skill', content: `${masked}\nAN EDIT\n` });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'skill_masked');
  assert.ok(!r.text.includes(VALUE), 'the refusal repeats no value');
  assert.equal(readFileSync(skillFile('vault-skill'), 'utf8'), SKILL, 'the file is untouched');

  const byPath = await call('POST', '/api/skills', mission, { path: skillFile('vault-skill'), content: masked });
  assert.equal(byPath.status, 409, 'nor by naming its file');
  assert.equal(readFileSync(skillFile('vault-skill'), 'utf8'), SKILL);
});

test('the guard stops only that write', async () => {
  const stars = '---\nname: starred\ndescription: Bold.\n---\n\n***really*** important\n';
  assert.equal((await call('POST', '/api/skills', mission, { id: 'starred', content: stars })).status, 200, 'a skill without a value keeps its markdown');
  assert.equal((await call('POST', '/api/skills', mission, { id: 'starred', content: `${stars}\nAGAIN\n` })).status, 200);

  upsertSkill('vault-rewrite', `---\nname: vault-rewrite\ndescription: Rewritten.\n---\n\ntoken=${VALUE}\n`);
  const clean = '---\nname: vault-rewrite\ndescription: Rewritten.\n---\n\nthe token comes from the environment\n';
  assert.equal((await call('POST', '/api/skills', mission, { id: 'vault-rewrite', content: clean })).status, 200, 'dropping the value on purpose is a choice');
  assert.equal(readFileSync(skillFile('vault-rewrite'), 'utf8'), clean);

  upsertSkill('vault-session', `---\nname: vault-session\ndescription: Editor.\n---\n\ntoken=${VALUE}\n`);
  const typed = '---\nname: vault-session\ndescription: Editor.\n---\n\ntoken=***\n';
  assert.equal((await call('POST', '/api/skills', session, { id: 'vault-session', content: typed })).status, 200, 'a person in the editor reads what they overwrite');
});
