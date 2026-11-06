/**
 * secu-4 — a caller who HAS `agents:manage` / `missions:spawn` but is not
 * superadmin may not widen, through the request BODY, what an admin granted:
 * permission mode, tools, MCP servers, backend/model, cwd. One test per
 * refused override; each refusal must also land in `audit_log`.
 * Isolated TIMON_HOME, witness on 127.0.0.1:0.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-agents-secu4-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./routes.js');
const { registerRoutes: registerMissionRoutes } = await import('../missions/routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { catalogBackend } = await import('../../backends/catalog.js');
const { spawnOverrideRefusal, agentConfigRefusal } = await import(
  '../../users/privileged-overrides.js'
);

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);
registerMissionRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

function reasonOf(json: unknown): string {
  return (json as { reason?: string }).reason ?? '';
}

/** The refusal must be the guard's, not secu-1's route gate (same 403). */
function assertDenied(
  result: { status: number; json: unknown },
  needle: string,
): void {
  assert.equal(result.status, 403);
  assert.match(reasonOf(result.json), new RegExp(needle));
}

function auditedReasons(): string[] {
  return dbApi.listAuditLog(200)
    .filter((row) => row.action === 'spawn.override_denied' || row.action === 'agent.config_denied')
    .map((row) => row.target ?? '');
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);

// Mallory is the case secu-1 does NOT cover: a delegated admin. She holds
// `agents:manage` + `missions:spawn`, so every route gate lets her through and
// only secu-4 stands between her and a shell.
const created = await postTestAccount(dbApi, { email: 'mallory@example.com', name: 'Mallory', password: 'mallory-secret' });
assert.equal(created.status, 201);
const malloryId = (created.json as { user: { id: string } }).user.id;
grantTestPermissions(dbApi, malloryId, ['agents:manage', 'missions:spawn', 'missions:read']);
const login = await call('POST', '/api/auth/login', {
  body: { email: 'mallory@example.com', password: 'mallory-secret' },
});
const cookie = sessionCookie(login.res)!;
assert.ok(cookie);

// A project working directory is the ONLY place she may point an agent at.
const projectCwd = mkdtempSync(join(tmpdir(), 'timon-secu4-project-'));
const outsideCwd = mkdtempSync(join(tmpdir(), 'timon-secu4-outside-'));
dbApi.upsertProject('witness', { cwd: projectCwd });

// An agent an admin already configured: the yardstick every override is
// measured against.
const target = await call('POST', '/api/agents', {
  bearer: TOKEN,
  body: {
    name: 'witness.target',
    system_prompt: 'witness',
    config: {
      cwd: projectCwd,
      allowed_tools: ['Bash(git:*)', 'Read'],
      mcp_servers: ['known-mcp'],
    },
  },
});
assert.equal(target.status, 200);

test('spawn: permission_mode bypassPermissions is refused', async () => {
  const r = await call('POST', '/api/missions', {
    cookie,
    body: { agent: 'witness.target', mission: 'ping', permission_mode: 'bypassPermissions' },
  });
  assertDenied(r, 'permission_mode');
});

test('spawn: extra_allowed_tools beyond the agent declaration is refused', async () => {
  const wildcard = await call('POST', '/api/missions', {
    cookie,
    body: { agent: 'witness.target', mission: 'ping', extra_allowed_tools: ['Bash(*)'] },
  });
  assertDenied(wildcard, 'extra_allowed_tools');

  // A declared specialisation must never cover the bare base tool.
  const bareBase = await call('POST', '/api/missions', {
    cookie,
    body: { agent: 'witness.target', mission: 'ping', extra_allowed_tools: ['Bash'] },
  });
  assertDenied(bareBase, 'extra_allowed_tools');
});

test('spawn: extra_mcp_servers the agent does not declare is refused', async () => {
  const r = await call('POST', '/api/agents/spawn', {
    cookie,
    body: { agent: 'witness.target', mission: 'ping', extra_mcp_servers: ['pwn'] },
  });
  assertDenied(r, 'extra_mcp_servers');
});

test('spawn: an uncatalogued backend_override is refused', async () => {
  const r = await call('POST', '/api/missions', {
    cookie,
    body: { agent: 'witness.target', mission: 'ping', backend_override: 'pwn-cli' },
  });
  assertDenied(r, 'unknown backend');
});

test('spawn: an uncatalogued model_override is refused', async () => {
  const r = await call('POST', '/api/missions', {
    cookie,
    body: { agent: 'witness.target', mission: 'ping', model_override: 'pwn-model-9000' },
  });
  assertDenied(r, 'catalogue');
});

test('spawn: allowed_tools cannot be replaced wholesale', async () => {
  const r = await call('POST', '/api/missions', {
    cookie,
    body: { agent: 'witness.target', mission: 'ping', allowed_tools: ['Bash'] },
  });
  assertDenied(r, 'allowed_tools');
});

test('agent create: an arbitrary cwd is refused, a project cwd passes', async () => {
  const outside = await call('POST', '/api/agents', {
    cookie,
    body: { name: 'mallory.pwn', system_prompt: 'pwn', config: { cwd: outsideCwd } },
  });
  assertDenied(outside, 'outside every project');

  const inside = await call('POST', '/api/agents', {
    cookie,
    body: { name: 'mallory.ok', system_prompt: 'ok', config: { cwd: projectCwd } },
  });
  assert.equal(inside.status, 200);
});

test('agent create: bypassPermissions and pre-allocated tools are refused', async () => {
  const mode = await call('POST', '/api/agents', {
    cookie,
    body: {
      name: 'mallory.pwn2',
      system_prompt: 'pwn',
      config: { cwd: projectCwd, permission_mode: 'bypassPermissions' },
    },
  });
  assertDenied(mode, 'permission_mode');

  const tools = await call('POST', '/api/agents', {
    cookie,
    body: {
      name: 'mallory.pwn3',
      system_prompt: 'pwn',
      config: { cwd: projectCwd, allowed_tools: ['Bash'] },
    },
  });
  assertDenied(tools, 'allowed_tools');

  const mcp = await call('POST', '/api/agents', {
    cookie,
    body: {
      name: 'mallory.pwn4',
      system_prompt: 'pwn',
      config: { cwd: projectCwd, mcp_servers: ['pwn'] },
    },
  });
  assertDenied(mcp, 'mcp_servers');
});

test('agent patch: widening is refused, narrowing passes', async () => {
  const widen = await call('PATCH', '/api/agents/witness.target/config', {
    cookie,
    body: { allowed_tools: ['Bash(git:*)', 'Read', 'Bash'] },
  });
  assertDenied(widen, 'allowed_tools');

  const escape = await call('PATCH', '/api/agents/witness.target/config', {
    cookie,
    body: { cwd: outsideCwd },
  });
  assertDenied(escape, 'outside every project');

  const narrow = await call('PATCH', '/api/agents/witness.target/config', {
    cookie,
    body: { allowed_tools: ['Read'] },
  });
  assert.equal(narrow.status, 200);
});

test('the daemon-token (superadmin) keeps every override', async () => {
  const r = await call('PATCH', '/api/agents/witness.target/config', {
    bearer: TOKEN,
    body: { permission_mode: 'bypassPermissions', cwd: outsideCwd },
  });
  assert.equal(r.status, 200);
});

test('every refusal is recorded in the audit log', () => {
  const reasons = auditedReasons();
  assert.ok(reasons.length >= 8, `expected the refusals to be audited, got ${reasons.length}`);
  assert.ok(reasons.some((r) => r.includes('permission_mode')));
  assert.ok(reasons.some((r) => r.includes('agent:witness.target')));
});

test('a spawn override that stays inside the agent declaration is accepted', () => {
  const cfg = { allowed_tools: ['Bash(git:*)', 'Read'], mcp_servers: ['known-mcp'] };
  assert.equal(
    spawnOverrideRefusal({ extra_allowed_tools: ['Bash(git:log)', 'Read'] }, cfg),
    null,
  );
  assert.equal(spawnOverrideRefusal({ extra_mcp_servers: ['known-mcp'] }, cfg), null);
  assert.equal(spawnOverrideRefusal({ permission_mode: 'acceptEdits' }, cfg), null);
  const claude = catalogBackend('claude');
  if (claude?.defaultModel) {
    assert.equal(
      spawnOverrideRefusal({ backend_override: 'claude', model_override: claude.defaultModel }, cfg),
      null,
    );
  }
  assert.equal(agentConfigRefusal({ permission_mode: 'auto' }, null), null);
});
