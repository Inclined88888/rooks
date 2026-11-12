/**
 * Regression test for the permission bridge's authentication.
 *
 * `bin/permission-mcp.mjs` is the only path by which an agent can ask the user
 * for a permission. It used to post `/api/permissions/request` with no
 * `Authorization` header at all: fine while the instance had no user account
 * (the daemon tolerates an anonymous caller only then), but every card 401s the
 * moment accounts exist — so on a multi-user instance no agent could spawn a
 * mission, send a message, or do anything else the classifier defers.
 *
 * The shim is a stdio subprocess, not a module: a unit test of an exported
 * function would prove nothing about what actually goes on the wire. So this
 * runs the real script against a bounded witness server and reads the headers
 * it receives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SHIM = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'permission-mcp.mjs');
const TOKEN = 'mission-token-2f6c1d';

type Capture = { authorization?: string; body: unknown };

/** Only the fields this test reads back from the shim's JSON-RPC replies. */
type RpcReply = {
  id?: number;
  error?: { message: string };
  result?: { content?: { text: string }[] };
};

/** Witness daemon: records what the shim sent, answers like the real route. */
function startWitness(): Promise<{ url: string; seen: Capture[]; close: () => Promise<void> }> {
  const seen: Capture[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const auth = req.headers.authorization;
      seen.push({ authorization: typeof auth === 'string' ? auth : undefined, body: JSON.parse(raw || '{}') });
      // Same contract as the daemon: no identity → 401 once accounts exist.
      if (!auth) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ behavior: 'allow', updatedInput: { ok: true } }));
    });
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ready({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

/**
 * Drives one `tools/call request` through the real shim and returns the
 * JSON-RPC reply plus everything the process printed. `env` is built from
 * scratch, never inherited: the point is to prove which variables the shim
 * actually needs.
 */
function askOnce(orchUrl: string, token: string | undefined): Promise<{ reply: RpcReply; output: string }> {
  const child = spawn(process.execPath, [SHIM], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      ROOKS_ORCH_URL: orchUrl,
      ROOKS_MISSION_ID: 'mission-under-test',
      ROOKS_AGENT: 'company.ceo',
      ...(token ? { ROOKS_API_TOKEN: token } : {}),
    },
  });
  let output = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { output += c; });
  const lines = readline.createInterface({ input: child.stdout });

  return new Promise<{ reply: RpcReply; output: string }>((resolve_, reject) => {
    // Bounded: the shim retries network failures forever by design, so a bug
    // must fail this test rather than hang the suite.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no reply from the shim within 10s; output: ${output}`));
    }, 10_000);
    const finish = (value: { reply: RpcReply; output: string }) => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve_(value);
    };
    lines.on('line', (line) => {
      output += line + '\n';
      let msg: RpcReply;
      try { msg = JSON.parse(line) as RpcReply; } catch { return; }
      if (msg.id === 1) {
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: {
            name: 'request',
            arguments: { tool_name: 'mcp__nova__agent_send_message', input: { to: 'company.marketing' }, tool_use_id: 'tu-1' },
          },
        }) + '\n');
        return;
      }
      if (msg.id === 2) finish({ reply: msg, output });
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  });
}

test('the permission bridge sends the mission Bearer, and the decision comes back', async () => {
  const witness = await startWitness();
  try {
    const { reply, output } = await askOnce(witness.url, TOKEN);
    assert.equal(witness.seen.length, 1, 'exactly one POST');
    assert.equal(witness.seen[0]!.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual((witness.seen[0]!.body as { mission_id: string }).mission_id, 'mission-under-test');
    assert.equal(reply.error, undefined, 'no JSON-RPC error');
    const decision = JSON.parse(reply.result!.content![0]!.text) as { behavior: string };
    assert.equal(decision.behavior, 'allow');
    // The token authenticates the mission; it must never be echoed anywhere
    // Claude (and therefore the transcript, and the UI) can read it.
    assert.ok(!output.includes(TOKEN), 'the token must not appear in the shim output');
  } finally {
    await witness.close();
  }
});

test('with no mission token the request is refused, never retried as anonymous', async () => {
  const witness = await startWitness();
  try {
    const { reply, output } = await askOnce(witness.url, undefined);
    assert.equal(witness.seen.length, 1, 'a definitive 401 is not retried');
    assert.equal(witness.seen[0]!.authorization, undefined, 'no header invented from nowhere');
    assert.ok(reply.error, 'the refusal reaches Claude as an error');
    assert.match(reply.error!.message, /401/);
    assert.ok(!output.includes(TOKEN));
  } finally {
    await witness.close();
  }
});
