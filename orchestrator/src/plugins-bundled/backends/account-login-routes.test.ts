/**
 * Signing a subscription account in from the browser (TODO #52, volet 3).
 * The CLI is a fake child driven by the test: no real `claude` nor `codex`
 * runs. Isolated ROOKS_HOME, witness server on 127.0.0.1:0.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.ROOKS_HOME = mkdtempSync(join(tmpdir(), 'rooks-account-login-'));
await import('../../../tests/helpers/paid-license.js');
process.env.ROOKS_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerAccountRoutes } = await import('./account-routes.js');
const {
  accountConfigDir, accountLoginStagingDir, getBackendAccount, setBackendAccountStatus,
} = await import('../../backends/accounts.js');
const { normalizeLoginCode, resetAccountLogins, setLoginOptions } = await import('../../backends/account-login.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');

class FakeCli extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly args: string[], readonly env: NodeJS.ProcessEnv) { super(); }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = signal;
      this.emit('exit', null, signal);
    }
    return true;
  }
  exit(code: number): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

const CODE = 'Secr3tAuthCode_abc#St4te-xyz';
/** Who the next sign-in turns out to be. */
let nextEmail = 'ada@perso.example';
let lastCli: FakeCli | null = null;
const runs: string[][] = [];

function codexIdToken(email: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({
    email, sub: `sub-${email}`,
    'https://api.openai.com/auth': { chatgpt_account_id: `acct-${email}`, chatgpt_user_id: `user-${email}` },
  })}.sig`;
}

function fakeSpawn(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }): ChildProcess {
  const cli = new FakeCli(args, opts.env);
  lastCli = cli;
  setImmediate(() => {
    if (cmd === 'codex') {
      cli.stdout.write('\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n2. Enter this one-time code\n   \u001b[94mABCD-12345\u001b[0m\n');
      return;
    }
    cli.stdout.write('If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc\nPaste code here if prompted > ');
    cli.stdin.on('data', (chunk: Buffer) => {
      const code = chunk.toString().trim();
      if (code !== CODE) return cli.exit(1);
      const dir = opts.env.CLAUDE_CONFIG_DIR!;
      writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `token-${nextEmail}` } }));
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: nextEmail } }));
      cli.exit(0);
    });
  });
  return cli as unknown as ChildProcess;
}

/** The codex device page was approved: the CLI writes its file and leaves. */
function approveCodex(): void {
  const cli = lastCli!;
  writeFileSync(join(cli.env.CODEX_HOME!, 'auth.json'), JSON.stringify({ tokens: { id_token: codexIdToken(nextEmail) } }));
  cli.exit(0);
}

async function fakeRun(_cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  runs.push(args);
  const dir = env.CLAUDE_CONFIG_DIR!;
  if (args[1] === 'logout') return { code: 0, stdout: '' };
  if (!existsSync(join(dir, '.credentials.json'))) return { code: 1, stdout: JSON.stringify({ loggedIn: false }) };
  const email = (JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as { oauthAccount: { emailAddress: string } }).oauthAccount.emailAddress;
  return { code: 0, stdout: JSON.stringify({ loggedIn: true, email, orgId: `org-${email}` }) };
}

setLoginOptions({ spawn: fakeSpawn, run: fakeRun, platform: 'linux', promptTimeoutMs: 5_000, retainMs: 60_000, resolveBin: () => null });

const logged: string[] = [];
{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level];
  console[level] = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); original(...parts); };
}

const DAEMON = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: DAEMON, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAccountRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { resetAccountLogins(); server.close(); });

type Login = { state: string; failure: string | null; identity: string | null; codeSent: boolean; prompt: { kind: string; url: string; code?: string } | null };
type Reply = { status: number; text: string; json: Record<string, unknown> & { login?: Login; account?: { id: string; state: string; connected: boolean; identity?: string | null } } };

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : {} };
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`))!;
  return decodeURIComponent(line.split(';')[0]!.slice(SESSION_COOKIE.length + 1));
}

async function settled(id: string, cookie: string): Promise<Login> {
  for (let i = 0; i < 100; i++) {
    const login = (await call('GET', `/api/backends/accounts/${id}/login`, { cookie })).json.login!;
    if (login.state === 'connected' || login.state === 'failed') return login;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the flow never settled');
}

async function waitingFor(id: string, cookie: string): Promise<Login> {
  for (let i = 0; i < 100; i++) {
    const login = (await call('GET', `/api/backends/accounts/${id}/login`, { cookie })).json.login!;
    if (login.state !== 'starting') return login;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the CLI never printed its prompt');
}

async function createAccount(cookie: string, body: Record<string, unknown>): Promise<string> {
  const created = await call('POST', '/api/backends/accounts', { cookie, body });
  assert.equal(created.status, 201, created.text);
  return created.json.account!.id;
}

/** The whole paste flow, as the browser does it. */
async function connectClaude(id: string, cookie: string): Promise<Login> {
  assert.equal((await call('POST', `/api/backends/accounts/${id}/login`, { cookie, body: {} })).status, 202);
  const waiting = await waitingFor(id, cookie);
  assert.equal(waiting.state, 'waiting');
  const sent = await call('POST', `/api/backends/accounts/${id}/login/code`, { cookie, body: { code: CODE } });
  assert.equal(sent.status, 200, sent.text);
  return settled(id, cookie);
}

assert.equal((await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } })).status, 201);
const admin = await login('admin@example.com', 'admin-secret');
for (const who of ['ada', 'bob']) {
  assert.equal((await postTestAccount(dbApi, { email: `${who}@example.com`, name: who, password: `${who}-secret` })).status, 201);
}
const ada = await login('ada@example.com', 'ada-secret');
const bob = await login('bob@example.com', 'bob-secret');
const adaId = dbApi.getUserByEmail('ada@example.com')!.id;
const bobId = dbApi.getUserByEmail('bob@example.com')!.id;
const adaPerso = await createAccount(ada, { backend: 'claude', name: 'Perso' });

test('an anonymous caller is refused on every sign-in route', async () => {
  for (const [method, path] of [['POST', 'login'], ['GET', 'login'], ['POST', 'login/code'], ['DELETE', 'login']] as const) {
    const res = await call(method, `/api/backends/accounts/${adaPerso}/${path}`, { body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('the daemon token and a mission token never start a sign-in', async () => {
  assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login`, { bearer: DAEMON, body: {} })).status, 403);
  dbApi.createMission('mission-login', 'login-agent', 'brief', undefined, adaId);
  const secret = issueMissionApiToken('mission-login');
  assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login`, { bearer: secret, body: {} })).status, 403);
});

test('a user never signs in someone else\'s account, granted or not', async () => {
  assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login`, { cookie: bob, body: {} })).status, 404);
  assert.equal((await call('PUT', `/api/backends/accounts/${adaPerso}/grants`, { cookie: admin, body: { userIds: [bobId] } })).status, 200);
  assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login`, { cookie: bob, body: {} })).status, 403,
    'a granted account is used, not signed in');
  assert.equal((await call('PUT', `/api/backends/accounts/${adaPerso}/grants`, { cookie: admin, body: { userIds: [] } })).status, 200);
});

test('a user signs their account in by pasting the code; nothing secret leaves', async () => {
  setBackendAccountStatus(adaPerso, 'reauth');
  const started = await call('POST', `/api/backends/accounts/${adaPerso}/login`, { cookie: ada, body: {} });
  assert.equal(started.status, 202);
  const waiting = await waitingFor(adaPerso, ada);
  assert.deepEqual(waiting.prompt, { kind: 'paste-code', url: 'https://claude.com/cai/oauth/authorize?code=true&state=abc' });

  const otherSession = await login('ada@example.com', 'ada-secret');
  assert.equal((await call('GET', `/api/backends/accounts/${adaPerso}/login`, { cookie: otherSession })).status, 404,
    'the flow belongs to the session that started it');
  assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login/code`, { cookie: otherSession, body: { code: CODE } })).status, 404);
  assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login/code`, { cookie: ada, body: { code: `${CODE}\nmore` } })).status, 400,
    'a line break would feed the CLI\'s next prompt');
  assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login/code`, { cookie: ada, body: { code: 'not a code' } })).status, 400);

  const sent = await call('POST', `/api/backends/accounts/${adaPerso}/login/code`, { cookie: ada, body: { code: CODE } });
  assert.equal(sent.status, 200);
  assert.ok(!sent.text.includes(CODE), 'the code is never echoed back');
  const done = await settled(adaPerso, ada);
  assert.equal(done.state, 'connected');
  assert.equal(done.identity, 'ada@perso.example');

  const row = getBackendAccount(adaPerso)!;
  assert.equal(row.status, 'active', 'signed in again: back in rotation');
  assert.equal(row.identity_label, 'ada@perso.example');
  const credential = join(accountConfigDir(adaPerso), '.credentials.json');
  assert.ok(existsSync(credential));
  if (process.platform !== 'win32') assert.equal(statSync(credential).mode & 0o777, 0o600);
  assert.equal(existsSync(accountLoginStagingDir(adaPerso)), false, 'no copy of the sign-in survives the flow');
  assert.ok(!logged.some((line) => line.includes(CODE) || line.includes('Secr3t')), 'the code never reaches a log');

  const page = (await call('GET', '/api/backends/accounts', { cookie: ada })).json;
  assert.deepEqual([...(page.backends as string[])].sort(), ['claude', 'codex'], 'where an account can be added');
  const listed = page.accounts as { id: string; connected: boolean; identity: string }[];
  const mine = listed.find((a) => a.id === adaPerso)!;
  assert.equal(mine.connected, true);
  assert.equal(mine.identity, 'ada@perso.example');
  assert.ok(dbApi.listAuditLog().some((entry) => entry.action === 'backend_account.connect' && entry.user_id === adaId));
});

test('the superadmin signs in an account for another user, audited', async () => {
  const bobWork = await createAccount(admin, { backend: 'claude', name: 'Work', ownerUserId: bobId });
  nextEmail = 'bob@work.example';
  const done = await connectClaude(bobWork, admin);
  assert.equal(done.state, 'connected');
  assert.equal(getBackendAccount(bobWork)!.owner_user_id, bobId, 'registered under the target user');
  const audit = dbApi.listAuditLog().find((entry) => entry.action === 'backend_account.connect' && entry.target?.includes(bobWork));
  assert.ok(audit);
  assert.equal(audit!.user_id, dbApi.getUserByEmail('admin@example.com')!.id);
  assert.ok(audit!.target!.includes(`owner:${bobId}`));
});

test('the same subscription under a second name is refused, and nothing is installed', async () => {
  const second = await createAccount(ada, { backend: 'claude', name: 'Second' });
  nextEmail = 'ada@perso.example';
  const done = await connectClaude(second, ada);
  assert.equal(done.state, 'failed');
  assert.equal(done.failure, 'duplicate');
  assert.equal(getBackendAccount(second)!.identity_key, null);
  assert.equal(existsSync(join(accountConfigDir(second), '.credentials.json')), false);
});

test('a reconnect as someone else is refused and the previous sign-in stays', async () => {
  const credential = join(accountConfigDir(adaPerso), '.credentials.json');
  const before = readFileSync(credential, 'utf8');
  nextEmail = 'stranger@example.com';
  const done = await connectClaude(adaPerso, ada);
  assert.equal(done.state, 'failed');
  assert.equal(done.failure, 'mismatch');
  assert.equal(done.identity, 'ada@perso.example', 'says who was expected');
  assert.equal(readFileSync(credential, 'utf8'), before);
  assert.equal(getBackendAccount(adaPerso)!.identity_label, 'ada@perso.example');
});

test('a wrong code fails the flow', async () => {
  assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login`, { cookie: ada, body: {} })).status, 202);
  await waitingFor(adaPerso, ada);
  assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login/code`, { cookie: ada, body: { code: 'wrong#code' } })).status, 200);
  const done = await settled(adaPerso, ada);
  assert.equal(done.failure, 'code_rejected');
});

test('a cancelled flow stops the CLI and clears its staging', async () => {
  assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login`, { cookie: ada, body: {} })).status, 202);
  await waitingFor(adaPerso, ada);
  const cli = lastCli!;
  assert.ok(existsSync(accountLoginStagingDir(adaPerso)));
  const cancelled = await call('DELETE', `/api/backends/accounts/${adaPerso}/login`, { cookie: ada });
  assert.equal(cancelled.json.login!.failure, 'cancelled');
  assert.equal(cli.signalCode, 'SIGTERM');
  assert.equal(existsSync(accountLoginStagingDir(adaPerso)), false);
});

test('an expired flow stops the CLI', async () => {
  setLoginOptions({ ttlMs: () => 150 });
  try {
    assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login`, { cookie: ada, body: {} })).status, 202);
    const cli = lastCli!;
    const done = await settled(adaPerso, ada);
    assert.equal(done.failure, 'expired');
    assert.equal(done.prompt, null);
    assert.equal(cli.signalCode, 'SIGTERM');
  } finally {
    setLoginOptions({ ttlMs: () => 60_000 });
  }
});

test('codex signs in with a device code', async () => {
  const codex = await createAccount(ada, { backend: 'codex', name: 'GPT' });
  assert.equal((await call('POST', `/api/backends/accounts/${codex}/login`, { cookie: ada, body: {} })).status, 202);
  const waiting = await waitingFor(codex, ada);
  assert.deepEqual(waiting.prompt, { kind: 'device-code', url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
  assert.ok(lastCli!.args.includes('--device-auth'));
  assert.ok(lastCli!.args.includes('cli_auth_credentials_store=file'), 'the sign-in is a file the missions can link to');
  assert.equal(lastCli!.env.OPENAI_API_KEY, '', 'an inherited key never signs the account in');
  assert.equal((await call('POST', `/api/backends/accounts/${codex}/login/code`, { cookie: ada, body: { code: 'ABCD' } })).status, 409,
    'a device flow takes no pasted code');
  nextEmail = 'ada@gpt.example';
  approveCodex();
  const done = await settled(codex, ada);
  assert.equal(done.state, 'connected');
  assert.equal(done.identity, 'ada@gpt.example');
  assert.ok(existsSync(join(accountConfigDir(codex), 'auth.json')));
});

// TODO #486: an npm codex runs `env node`, which the service's PATH does not hold.
test('codex login gets its own folder and a node on PATH, as a mission does', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-login-path-'));
  const [servicePath, cliDir, nodeDir] = ['service', 'cli', 'node'].map((name) => join(root, name));
  for (const dir of [servicePath!, cliDir!, nodeDir!]) mkdirSync(dir);
  writeFileSync(join(cliDir!, 'codex'), '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(join(nodeDir!, 'node'), '', { mode: 0o755 });
  const inherited = process.env.PATH;
  process.env.PATH = servicePath;
  setLoginOptions({ resolveBin: (name) => name === 'codex' ? join(cliDir!, 'codex') : name === 'node' ? join(nodeDir!, 'node') : null });
  const codex = await createAccount(ada, { backend: 'codex', name: 'GPT launch path' });
  try {
    assert.equal((await call('POST', `/api/backends/accounts/${codex}/login`, { cookie: ada, body: {} })).status, 202);
    await waitingFor(codex, ada);
    assert.deepEqual(lastCli!.env.PATH?.split(posix.delimiter), [cliDir, servicePath, nodeDir],
      'the CLI folder first, the service PATH kept, then the node found elsewhere');
  } finally {
    process.env.PATH = inherited;
    setLoginOptions({ resolveBin: () => null });
    await call('DELETE', `/api/backends/accounts/${codex}/login`, { cookie: ada });
    rmSync(root, { recursive: true, force: true });
  }
});

test('macOS claude signs in in place; a refused identity is signed out and waits for a reconnect', async () => {
  setLoginOptions({ platform: 'darwin' });
  try {
    const mac = await createAccount(ada, { backend: 'claude', name: 'Mac' });
    nextEmail = 'ada@perso.example';
    const done = await connectClaude(mac, ada);
    assert.equal(done.failure, 'duplicate');
    assert.ok(runs.some((args) => args.join(' ') === 'auth logout'));
    assert.equal(getBackendAccount(mac)!.status, 'reauth');
  } finally {
    setLoginOptions({ platform: 'linux' });
  }
});

test('deleting an account stops its flow', async () => {
  const doomed = await createAccount(ada, { backend: 'claude', name: 'Doomed' });
  assert.equal((await call('POST', `/api/backends/accounts/${doomed}/login`, { cookie: ada, body: {} })).status, 202);
  await waitingFor(doomed, ada);
  const cli = lastCli!;
  assert.equal((await call('DELETE', `/api/backends/accounts/${doomed}`, { cookie: ada })).status, 200);
  assert.equal(cli.signalCode, 'SIGTERM');
  assert.equal((await call('GET', `/api/backends/accounts/${doomed}/login`, { cookie: ada })).status, 404);
});

test('the pasted text may be the code or the final URL of the provider\'s page', () => {
  assert.equal(normalizeLoginCode('  abc_DEF-1#state.2 '), 'abc_DEF-1#state.2');
  assert.equal(normalizeLoginCode('https://platform.claude.com/oauth/code/callback?code=abc&state=xyz'), 'abc#xyz');
  assert.equal(normalizeLoginCode('https://example.com/?nothing=1'), null);
  assert.equal(normalizeLoginCode('two words'), null);
  assert.equal(normalizeLoginCode('a;rm -rf'), null);
  assert.equal(normalizeLoginCode('a+b/c=%2F#st=ate'), 'a+b/c=%2F#st=ate', 'any printable code the provider may show');
  assert.equal(normalizeLoginCode('abc\u0007def'), null);
});

test('a staging directory that cannot be removed never takes the daemon down', async () => {
  setLoginOptions({ removeDir: () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); } });
  try {
    assert.equal((await call('POST', `/api/backends/accounts/${adaPerso}/login`, { cookie: ada, body: {} })).status, 202);
    await waitingFor(adaPerso, ada);
    const cancelled = await call('DELETE', `/api/backends/accounts/${adaPerso}/login`, { cookie: ada });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.login!.failure, 'cancelled');
  } finally {
    setLoginOptions({ removeDir: (dir) => rmSync(dir, { recursive: true, force: true }) });
  }
});
