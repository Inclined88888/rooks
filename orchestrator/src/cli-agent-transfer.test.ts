/**
 * `timon agent export` / `timon agent import` (SUG-0084): the real CLI against
 * the real routes of the agent-import plugin, served on `127.0.0.1:0` — never
 * the machine's daemon. Usage errors, a refusal, a file never overwritten
 * without `--force`, an import that asks (and refuses to guess without a
 * terminal), then the round trip.
 */
import { createTestAccount, grantTestPermissions } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import { createPluginContext, daemonHost, type PluginContext } from './plugins/context.js';
import { readManifest } from './plugins/manifest.js';
import { createHttpPlugin } from './kernel/http-service.js';
import { createBodyParser } from './kernel/body-parser.js';
import { dbApi } from './db.js';
import { readDoc, upsertAgent, writeDoc } from './agent.js';
import { mountOfficialProviders } from '../tests/helpers/official-providers.js';

await mountOfficialProviders();

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
const pkg = (await import('../../plugins/agent-import/package.json', { with: { type: 'json' } })).default as { timon: unknown };
const lib = await import('../../plugins/agent-import/lib/index.js') as { apply(ctx: PluginContext): void };

const root = new Context();
const app = express();
// The CLI's bearer names the account here: what the daemon's auth does for a device or the operator.
app.use((req, _res, next) => {
  const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
  const user = bearer ? dbApi.getUserById(bearer) : undefined;
  if (user) req.auth = { kind: 'session', user, isSuperadmin: user.is_superadmin };
  next();
});
app.use(createBodyParser());
await root.plugin(createHttpPlugin(app));
let inner!: Context;
await root.plugin({ name: 'holder', apply(ctx: Context) { inner = ctx; } });
const read = readManifest(pkg);
assert.ok(read.ok);
lib.apply(createPluginContext(inner, { manifest: read.manifest, version: '0.1.0' }, daemonHost(root)));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await root.fiber.dispose();
});

function account(name: string, permissions: string[]): string {
  const id = randomUUID();
  createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'unused', status: 'active' });
  grantTestPermissions(dbApi, id, ['plugin:agent-import', ...permissions]);
  return id;
}

function cli(args: string[], token: string | null, cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, TIMON_API: API, TIMON_RESOURCE_GUARD_ENABLED: '0' };
    delete env.TIMON_API_TOKEN;
    delete env.TIMON_MISSION_ID;
    delete env.TIMON_AGENT;
    if (token) env.TIMON_API_TOKEN = token;
    const child = spawn(process.execPath, [TIMON, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => { out += String(c); });
    child.stderr.on('data', (c: Buffer) => { err += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const owner = account('cli-owner', ['agents:read', 'agents:manage']);
const work = mkdtempSync(join(tmpdir(), 'timon-cli-agent-transfer-'));

test('usage errors exit 64 and call nothing', async () => {
  for (const args of [['agent', 'export'], ['agent', 'export', 'a', '--all'], ['agent', 'import'], ['agent', 'import', 'a.zip', 'b.zip'], ['agent', 'import', '--hermes', '--prefix', '']]) {
    const r = await cli(args, owner, work);
    assert.equal(r.code, 64, args.join(' '));
    assert.match(r.err, /usage: timon agent (export|import)/);
  }
});

test('an export that the daemon refuses writes no file', async () => {
  const name = `cli-x-${randomUUID().slice(0, 6)}`;
  upsertAgent({ name, system_prompt: 'x', config: { role: 'coder', backend: 'claude' } });
  const anonymous = await cli(['agent', 'export', name, '--out', 'anon.zip'], null, work);
  assert.equal(anonymous.code, 2);
  assert.match(anonymous.err, /refused/);
  assert.equal(existsSync(join(work, 'anon.zip')), false);
  const unknown = await cli(['agent', 'export', 'no-such-agent', '--out', 'none.zip'], owner, work);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /not_found/);
});

test('export then import: a file is never replaced without --force, and the import asks first', async () => {
  const name = `cli-a-${randomUUID().slice(0, 6)}`;
  upsertAgent({ name, system_prompt: `You are ${name}.`, config: { role: 'coder', backend: 'claude' } });
  writeDoc(name, 'SOUL.md', `# ${name}\n\nSoul.`);

  const exported = await cli(['agent', 'export', name, '--out', 'agents.zip'], owner, work);
  assert.equal(exported.code, 0, exported.err);
  assert.match(exported.out, /exported 1 agent to .*agents\.zip/);
  const bytes = readFileSync(join(work, 'agents.zip'));
  assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK');

  writeFileSync(join(work, 'kept.zip'), 'mine');
  const kept = await cli(['agent', 'export', name, '--out', 'kept.zip'], owner, work);
  assert.equal(kept.code, 1);
  assert.equal(readFileSync(join(work, 'kept.zip'), 'utf8'), 'mine', 'an existing file is left alone');
  assert.equal((await cli(['agent', 'export', name, '--out', 'kept.zip', '--force'], owner, work)).code, 0);

  // No terminal and no --yes: the preview is shown, nothing is written.
  const asked = await cli(['agent', 'import', 'agents.zip'], owner, work);
  assert.equal(asked.code, 64, asked.err);
  assert.match(asked.out, new RegExp(`create +${name} → timon\\.${name}`));
  assert.match(asked.err, /--yes/);
  assert.equal(readDoc(`timon.${name}`, 'SOUL.md'), null);

  const done = await cli(['agent', 'import', 'agents.zip', '--yes'], owner, work);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, new RegExp(`created +${name} → timon\\.${name}`));
  assert.equal(readDoc(`timon.${name}`, 'SOUL.md'), `# ${name}\n\nSoul.`);
  assert.ok(!`${done.out}${done.err}`.match(/[A-Za-z0-9_-]{43}/), 'the staging token is never printed');
});

/** The daemon here is this process: Hermes is looked for under its HOME, as the service would. */
async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
}

test('import --hermes: no Hermes on the daemon\'s machine is said, and nothing is staged', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'timon-cli-hermes-none-'));
  const r = await withHome(empty, () => cli(['agent', 'import', '--hermes', '--yes'], owner, work));
  assert.equal(r.code, 2);
  assert.match(r.err, /Hermes cannot be imported .*not_found/);
});

test('import --hermes <profile>: only the named profile, the same preview, question and --yes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-cli-hermes-'));
  const profile = (rel: string, text: string) => {
    const path = join(home, '.hermes', rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const tag = randomUUID().slice(0, 6);
  profile('SOUL.md', `# Hermes ${tag}\n\nThe house assistant.\n`);
  profile(`profiles/c${tag}/SOUL.md`, `# Coder ${tag}\n\nWrites code.\n`);

  await withHome(home, async () => {
    const named = new RegExp(`create +c${tag} → (\\S+)`);
    const asked = await cli(['agent', 'import', '--hermes', `c${tag}`], owner, work);
    assert.equal(asked.code, 64, asked.err);
    assert.match(asked.out, named);
    assert.doesNotMatch(asked.out, /create +Hermes/, 'the profile not named is not read');
    assert.match(asked.err, /--yes/);

    const unknown = await cli(['agent', 'import', '--hermes', 'nobody', '--yes'], owner, work);
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /nobody/);

    const done = await cli(['agent', 'import', '--hermes', `c${tag}`, '--yes', '--json'], owner, work);
    assert.equal(done.code, 0, done.err);
    assert.match(done.out, /"status": "created"/);
    const agent = /"agent": "([^"]+)"/.exec(done.out)?.[1];
    assert.ok(agent, done.out);
    assert.match(readDoc(agent, 'SOUL.md') ?? '', new RegExp(`Coder ${tag}`));
    assert.ok(!`${done.out}${done.err}`.match(/[A-Za-z0-9_-]{43}/), 'the staging token is never printed');
  });
});

test('export-skill prints the skill, writes it with --out, and never replaces a file without --force', async () => {
  // Line endings aside: a Windows checkout may hold the file as CRLF.
  const lf = (text: string): string => text.replace(/\r\n/g, '\n');
  const skill = lf(readFileSync(fileURLToPath(new URL('../../plugins/agent-import/skills/timon-export/SKILL.md', import.meta.url)), 'utf8'));
  const usage = await cli(['agent', 'export-skill', 'extra'], owner, work);
  assert.equal(usage.code, 64);
  assert.match(usage.err, /usage: timon agent export-skill/);

  const anonymous = await cli(['agent', 'export-skill'], null, work);
  assert.equal(anonymous.code, 2);
  assert.match(anonymous.err, /refused/);

  const printed = await cli(['agent', 'export-skill'], owner, work);
  assert.equal(printed.code, 0, printed.err);
  assert.equal(lf(printed.out), skill);

  const written = await cli(['agent', 'export-skill', '--out', 'SKILL.md'], owner, work);
  assert.equal(written.code, 0, written.err);
  assert.equal(lf(readFileSync(join(work, 'SKILL.md'), 'utf8')), skill);
  writeFileSync(join(work, 'SKILL.md'), 'mine');
  assert.equal((await cli(['agent', 'export-skill', '--out', 'SKILL.md'], owner, work)).code, 1);
  assert.equal(readFileSync(join(work, 'SKILL.md'), 'utf8'), 'mine', 'an existing file is left alone');
  assert.equal((await cli(['agent', 'export-skill', '--out', 'SKILL.md', '--force'], owner, work)).code, 0);
  assert.equal(lf(readFileSync(join(work, 'SKILL.md'), 'utf8')), skill);
});
