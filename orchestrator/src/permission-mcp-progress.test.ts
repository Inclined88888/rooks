/**
 * TIM-0098: a `question` left unanswered for 30 minutes died on the agent's
 * side — the claude CLI aborts an MCP call that sent "no response or progress
 * for 1800s" — while its card stayed pending in the UI.
 *
 * Two halves, both on the wire, so this runs the real shim against a witness
 * daemon that holds the answer back like a human who has not clicked yet:
 *  - while it waits, the shim sends `notifications/progress` on the client's
 *    token (that is what resets the CLI's idle clock);
 *  - on `notifications/cancelled`, or when its client goes away, it closes the
 *    long-poll for good — no reply, and no retry that would open a new card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import http from 'node:http';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SHIM = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'permission-mcp.mjs');
const BEAT_MS = 100;

type Rpc = {
  id?: number;
  method?: string;
  params?: { progressToken?: unknown; progress?: number };
  error?: { message: string };
  result?: { content?: { text: string }[] };
};

/** Witness daemon: counts POSTs, keeps every response open until `answer()`. */
function startWitness() {
  const posts: number[] = [];
  const open: http.ServerResponse[] = [];
  let closedEarly = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      posts.push(Date.now());
      open.push(res);
      res.on('close', () => { if (!res.writableEnded) closedEarly += 1; });
    });
  });
  return new Promise<{
    url: string;
    posts: number[];
    closedEarly: () => number;
    answer: (body: unknown) => void;
    close: () => Promise<void>;
  }>((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      ready({
        url: `http://127.0.0.1:${port}`,
        posts,
        closedEarly: () => closedEarly,
        answer: (body) => {
          const res = open.shift();
          assert.ok(res, 'a POST is waiting');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        },
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

function startShim(orchUrl: string): { child: ChildProcessWithoutNullStreams; seen: Rpc[]; write: (m: unknown) => void } {
  const child = spawn(process.execPath, [SHIM], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      TIMON_ORCH_URL: orchUrl,
      TIMON_MISSION_ID: 'mission-under-test',
      TIMON_AGENT: 'company.ceo',
      TIMON_API_TOKEN: 'mission-token',
      TIMON_ASK_PROGRESS_MS: String(BEAT_MS),
    },
  });
  const seen: Rpc[] = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try { seen.push(JSON.parse(line) as Rpc); } catch { /* not JSON-RPC */ }
  });
  const write = (m: unknown) => { child.stdin.write(JSON.stringify(m) + '\n'); };
  write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  return { child, seen, write };
}

const QUESTIONS = [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }];

function askQuestion(write: (m: unknown) => void, id: number, progressToken?: number): void {
  write({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: {
      name: 'question',
      arguments: { questions: QUESTIONS },
      ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
    },
  });
}

/** Polls `check` until it holds, failing after `ms` so a bug cannot hang the suite. */
async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a call waiting on the human sends progress on the client token, then the answer', async () => {
  const witness = await startWitness();
  const shim = startShim(witness.url);
  try {
    await until(() => shim.seen.some((m) => m.id === 1), 'initialize reply');
    askQuestion(shim.write, 2, 7);
    await until(() => witness.posts.length === 1, 'the long-poll reaches the daemon');
    const progress = () => shim.seen.filter((m) => m.method === 'notifications/progress');
    await until(() => progress().length >= 3, 'three heartbeats');
    for (const p of progress()) assert.equal(p.params?.progressToken, 7, 'the token comes back as given');
    const values = progress().map((p) => p.params?.progress ?? 0);
    assert.ok(values.every((v, i) => i === 0 || v > values[i - 1]!), `progress strictly increases: ${values}`);

    witness.answer({ behavior: 'allow', updatedInput: { answers: { 'Ship it?': 'Yes' } } });
    await until(() => shim.seen.some((m) => m.id === 2), 'the answer');
    const reply = shim.seen.find((m) => m.id === 2)!;
    assert.deepEqual(JSON.parse(reply.result!.content![0]!.text), { answers: { 'Ship it?': 'Yes' } });

    const after = progress().length;
    await sleep(BEAT_MS * 3);
    assert.equal(progress().length, after, 'no heartbeat once the call is answered');
  } finally {
    shim.child.kill('SIGKILL');
    await witness.close();
  }
});

test('without a progress token the shim sends no progress', async () => {
  const witness = await startWitness();
  const shim = startShim(witness.url);
  try {
    await until(() => shim.seen.some((m) => m.id === 1), 'initialize reply');
    askQuestion(shim.write, 2);
    await until(() => witness.posts.length === 1, 'the long-poll reaches the daemon');
    await sleep(BEAT_MS * 4);
    assert.equal(shim.seen.filter((m) => m.method === 'notifications/progress').length, 0);
    witness.answer({ behavior: 'deny', message: 'user declined to answer' });
    await until(() => shim.seen.some((m) => m.id === 2), 'the answer');
  } finally {
    shim.child.kill('SIGKILL');
    await witness.close();
  }
});

test('notifications/cancelled closes the long-poll: no reply, no retry, no heartbeat', async () => {
  const witness = await startWitness();
  const shim = startShim(witness.url);
  try {
    await until(() => shim.seen.some((m) => m.id === 1), 'initialize reply');
    askQuestion(shim.write, 2, 9);
    await until(() => witness.posts.length === 1, 'the long-poll reaches the daemon');
    shim.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'interrupted' } });
    await until(() => witness.closedEarly() === 1, 'the daemon sees the socket close');
    const heartbeats = shim.seen.filter((m) => m.method === 'notifications/progress').length;
    // Past the shim's first backoff (2 s): a destroyed socket retried as a
    // network error would have POSTed again — a brand-new card in the UI.
    await sleep(2_500);
    assert.equal(witness.posts.length, 1, 'a cancelled call is not retried');
    assert.equal(shim.seen.some((m) => m.id === 2), false, 'a cancelled request gets no response');
    assert.equal(shim.seen.filter((m) => m.method === 'notifications/progress').length, heartbeats, 'heartbeat stopped');
    assert.equal(shim.child.exitCode, null, 'the shim itself stays up for the next call');
  } finally {
    shim.child.kill('SIGKILL');
    await witness.close();
  }
});

test('when its client goes away the shim drops its long-polls and exits', async () => {
  const witness = await startWitness();
  const shim = startShim(witness.url);
  try {
    await until(() => shim.seen.some((m) => m.id === 1), 'initialize reply');
    askQuestion(shim.write, 2);
    await until(() => witness.posts.length === 1, 'the long-poll reaches the daemon');
    const exited = new Promise<number | null>((done) => shim.child.on('exit', (code) => done(code)));
    shim.child.stdin.end();
    assert.equal(await exited, 0);
    await until(() => witness.closedEarly() === 1, 'the daemon sees the socket close');
  } finally {
    shim.child.kill('SIGKILL');
    await witness.close();
  }
});
