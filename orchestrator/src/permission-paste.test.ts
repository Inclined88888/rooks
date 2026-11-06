/**
 * "Paste into a terminal" on a shell-command permission card: the third answer
 * only the mission owner's browser can give, and that reaches the agent as an
 * instructive refusal. The refusals are what matter most here.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NormalizedEvent } from './backends/types.js';
import type { LateDelivery } from './plugins-bundled/terminal-web/command-requests.js';

await import('../tests/helpers/paid-license.js');
delete process.env.TIMON_TERMINAL_WEB_ENABLED;

const { dbApi } = await import('./db.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const { listPending, requestPermission } = await import('./permissions.js');
const { resetActiveModules, setActiveModules } = await import('./kernel/module-state.js');
const { permissionHost } = await import('./mission-session.js');
const { AcpSessionDriver } = await import('./backends/acp/driver.js');
const { relayPasteReply } = await import('./plugins-bundled/terminal-web/command-requests.js');
const { bus } = await import('./bus.js');

const owner = createTestAccount(dbApi, { email: 'owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
const stranger = createTestAccount(dbApi, { email: 'other@example.com', name: 'other', passwordHash: 'x', isSuperadmin: false });
const noTerminal = createTestAccount(dbApi, { email: 'noterm@example.com', name: 'noterm', passwordHash: 'x', isSuperadmin: false });
dbApi.createMission('m-paste', 'timon.coder', 'work', undefined, owner.id);
dbApi.createMission('m-noterm', 'timon.coder', 'work', undefined, noTerminal.id);
dbApi.createMission('m-acp', 'timon.coder', 'work', undefined, owner.id);

type Fake = { kind: 'daemon-token' | 'session' | 'api-token'; userId?: string; missionId?: string };
const app = express();
app.use(express.json());
// The real lookup lives in http/auth.ts; here the caller's identity is the test input.
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const fake = JSON.parse(raw) as Fake;
    const user = fake.userId ? dbApi.getUserById(fake.userId) ?? null : null;
    req.auth = {
      kind: fake.kind, user,
      isSuperadmin: fake.kind === 'daemon-token' || !!user?.is_superadmin,
      missionId: fake.missionId ?? null,
    };
  }
  next();
});
registerRoutes(app);
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function resolve(id: string, auth: Fake | null, body: unknown): Promise<Response> {
  return fetch(`${base}/api/permissions/${id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { 'x-test-auth': JSON.stringify(auth) } : {}) },
    body: JSON.stringify(body),
  });
}

let seq = 0;
function ask(missionId: string, toolName: string, input: unknown) {
  const toolUseId = `tu-${++seq}`;
  const decision = requestPermission({ mission_id: missionId, agent: 'timon.coder', tool_name: toolName, input, tool_use_id: toolUseId });
  const card = listPending(missionId).find((p) => p.tool_use_id === toolUseId);
  assert.ok(card, 'the card is pending');
  return { decision, card };
}

const ownerBrowser: Fake = { kind: 'session', userId: owner.id };

test.describe('paste on a shell-command card', { concurrency: false }, () => {
  test('a one-line Bash command offers allow, paste and deny, and the event says so', () => {
    const { card } = ask('m-paste', 'Bash', { command: 'sudo systemctl restart nginx' });
    assert.equal(card.shell_command, 'sudo systemctl restart nginx');
    assert.deepEqual(card.choices, ['allow', 'paste', 'deny']);
    const ev = dbApi.listEvents('m-paste').filter((e) => e.type === 'permission_request').at(-1)!;
    const payload = JSON.parse(ev.payload) as { shell_command?: string; choices?: string[] };
    assert.equal(payload.shell_command, 'sudo systemctl restart nginx');
    assert.deepEqual(payload.choices, ['allow', 'paste', 'deny']);
  });

  test('anonymous, the daemon token, the agent itself and another user cannot paste', async () => {
    const { card } = ask('m-paste', 'Bash', { command: 'sudo apt upgrade' });
    assert.equal((await resolve(card.id, null, { behavior: 'paste' })).status, 401);
    assert.equal((await resolve(card.id, { kind: 'daemon-token' }, { behavior: 'paste' })).status, 403);
    assert.equal((await resolve(card.id, { kind: 'api-token', userId: owner.id, missionId: 'm-paste' }, { behavior: 'paste' })).status, 403);
    // Someone who cannot read the mission does not learn the card exists.
    assert.equal((await resolve(card.id, { kind: 'session', userId: stranger.id }, { behavior: 'paste' })).status, 404);
    assert.ok(listPending('m-paste').some((p) => p.id === card.id), 'still pending');
  });

  test("the owner's browser pastes: the agent gets an instructive refusal and its turn goes on", async () => {
    const { card, decision } = ask('m-paste', 'Bash', { command: 'sudo reboot' });
    const res = await resolve(card.id, ownerBrowser, { behavior: 'paste', origin: 'ui_card_paste' });
    assert.equal(res.status, 200);
    const got = await decision;
    assert.equal(got.behavior, 'deny');
    assert.match((got as { message: string }).message, /runs `sudo reboot` themselves/);
    assert.match((got as { message: string }).message, /ask the user/);
    const ev = dbApi.listEvents('m-paste').filter((e) => e.type === 'permission_resolved').at(-1)!;
    const payload = JSON.parse(ev.payload) as { behavior: string; choice?: string; origin: string };
    assert.equal(payload.behavior, 'deny', 'older readers still see a deny');
    assert.equal(payload.choice, 'paste');
    assert.equal(payload.origin, 'ui_card_paste');
  });

  test('no paste where there is nothing to paste', async () => {
    const multi = ask('m-paste', 'Bash', { command: 'echo a\necho b' });
    assert.equal(multi.card.shell_command, undefined, 'a newline would run the first line on its own');
    assert.equal(multi.card.choices, undefined);
    assert.equal((await resolve(multi.card.id, ownerBrowser, { behavior: 'paste' })).status, 400);

    const write = ask('m-paste', 'Write', { file_path: 'x', content: 'y' });
    assert.equal(write.card.choices, undefined);
    assert.equal((await resolve(write.card.id, ownerBrowser, { behavior: 'paste' })).status, 400);

    const noterm = ask('m-noterm', 'Bash', { command: 'ls' });
    assert.equal(noterm.card.choices, undefined, 'an owner without the web terminal gets no paste button');

    setActiveModules(['@timon/missions']);
    try {
      const moduleOff = ask('m-paste', 'Bash', { command: 'ls' });
      assert.equal(moduleOff.card.choices, undefined, 'no terminal module, nowhere to paste');
    } finally {
      resetActiveModules();
    }

    // Allow and deny are untouched.
    assert.equal((await resolve(multi.card.id, ownerBrowser, { behavior: 'deny', message: 'no' })).status, 200);
    assert.equal((await multi.decision).behavior, 'deny');
  });
});

async function until<T>(probe: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const got = probe();
    if (got) return got;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Every text the agent said, deltas included, in order. */
function said(events: NormalizedEvent[]): string {
  return events.filter((e) => e.type === 'assistant_delta').map((e) => (e.payload as { text: string }).text).join('');
}

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), 'backends', 'acp', '__fixtures__', 'fake-acp-agent.mjs');

test.describe('paste on the shell card of an ACP agent', { concurrency: false }, () => {
  test('the command stays refused in the turn; once the turn is over the agent is told who runs it', async () => {
    const child = nodeSpawn(process.execPath, [FAKE_ACP], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr!.resume();
    const events: NormalizedEvent[] = [];
    // The runner's view of the mission, which `deliverLate` reads: a turn runs, or not.
    let turnActive = false;
    const delivered: string[] = [];
    let driver: InstanceType<typeof AcpSessionDriver> | null = null;
    const via: LateDelivery = {
      turnActive: () => turnActive,
      // What `sendToAgent` does for a session backend: the text becomes the next prompt.
      send: async (_missionId, text) => {
        delivered.push(text);
        turnActive = true;
        try { await driver!.prompt(text); } finally { turnActive = false; }
        return 'delivered';
      },
    };
    driver = new AcpSessionDriver({
      io: { stdin: child.stdin!, stdout: child.stdout! },
      host: {
        emit: (ev) => { events.push(ev); },
        // The production wiring (`agent.ts`): the real card, and the relay after the turn.
        requestPermission: permissionHost('m-acp', 'timon.coder', (input) => requestPermission(input),
          (command) => relayPasteReply('m-acp', command, via)),
      },
      cwd: mkdtempSync(join(tmpdir(), 'timon-acp-paste-')),
      systemPrompt: 'You are a Timon agent.',
      model: null,
      resumeSession: null,
      mcpServers: async () => [],
      permissionsByAgent: false,
      profileId: 'fake',
    });
    try {
      await driver.start();
      events.length = 0;
      turnActive = true;
      const turn = driver.prompt('permshell');
      const card = await until(() => listPending('m-acp').find((p) => p.tool_name === 'Bash'), 'the card');
      assert.equal(card.shell_command, 'sudo systemctl restart nginx', 'ACP execute is a Bash card');
      assert.deepEqual(card.choices, ['allow', 'paste', 'deny']);
      assert.equal((await resolve(card.id, ownerBrowser, { behavior: 'paste', origin: 'ui_card_paste' })).status, 200);
      await turn;
      turnActive = false;
      assert.equal(said(events), 'selected:deny', 'the agent got reject_once: the command is not run');
      assert.equal(delivered.length, 0, 'nothing is injected while the turn runs');

      events.length = 0;
      bus.publish({ kind: 'turn_complete', missionId: 'm-acp' });
      await until(() => said(events).includes('[permission]'), 'the relayed instruction');
      assert.equal(delivered.length, 1, 'told once');
      assert.match(said(events), /\[permission\] The user runs `sudo systemctl restart nginx` themselves/);
      assert.match(said(events), /ask the user for it/);
      assert.equal(listPending('m-acp').length, 0);
    } finally {
      driver.close();
      child.kill();
    }
  });

  test('allow and deny on the same card relay nothing', async () => {
    const delivered: string[] = [];
    const via: LateDelivery = { turnActive: () => false, send: async (_m, text) => { delivered.push(text); return 'delivered'; } };
    const decide = permissionHost('m-acp', 'timon.coder', (input) => requestPermission(input),
      (command) => relayPasteReply('m-acp', command, via));
    for (const behavior of ['allow', 'deny'] as const) {
      const answer = decide({ toolCallId: `acp-${behavior}`, tool: 'Bash', title: 'ls', input: { command: 'ls' } });
      const card = await until(() => listPending('m-acp').find((p) => p.tool_use_id === `acp-${behavior}`), 'the card');
      assert.equal((await resolve(card.id, ownerBrowser, { behavior })).status, 200);
      assert.equal((await answer).allow, behavior === 'allow');
    }
    await new Promise((r) => setImmediate(r));
    assert.equal(delivered.length, 0);
  });
});
