/**
 * The Hermes Gateway plugin's session driver against a fake gateway that
 * replays the frames measured on Hermes (plugins/hermes-gateway/test): no
 * network beyond 127.0.0.1, no Python. Two stream generations: 0.21.0 (no
 * `id:`, one reader, 404 on reconnection) and 0.21.6 (replay by
 * `Last-Event-ID`). What is tested is the SHIPPED bundle (`lib/index.js`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeResumeState } from '../backends/remote-session.js';
import type {
  NormalizedEvent, PermissionRequest, RemoteDialect, RemoteResumeState, RemoteSessionResume, SessionDriver,
} from '../backends/types.js';
import type { PluginUserConnection } from './integration-types.js';

type Timing = Partial<Record<'watchdogMs' | 'deadSocketMs' | 'tickMs' | 'pollMs' | 'unreachableBudgetMs' | 'admitAttempts' | 'rateLimitBudgetMs' | 'cancelGraceMs' | 'saveThrottleMs', number>>;
type Connections = {
  forUser(owner: string): Promise<PluginUserConnection[]>;
  userSecret(owner: string, id: string, name: string): Promise<string | undefined>;
};
type Launch = { kind: 'mission'; missionId: string; ownerUserId: string | null; agentName: string; project: string | null };

const plugin = await import('../../../plugins/hermes-gateway/lib/index.js') as {
  createHermesDialect(deps: {
    fetch: typeof globalThis.fetch;
    resolveTarget(launch: unknown, model: string | null): Promise<unknown>;
    timing?: Timing;
  }): RemoteDialect;
  resolveTarget(connections: Connections, typeId: string, launch: unknown, model: string | null): Promise<unknown>;
  parseModel(model: string | null): { profile: string; connectionId: string | null } | null;
};

type FakeRun = {
  id: string; status: string; sessionKey: string | null; body: Record<string, unknown>;
  approvals: Array<{ choice: string; request_id: string | null }>; stopped: boolean; profile: string;
};
type FakeGateway = {
  url: string;
  runs: Map<string, FakeRun>;
  requests: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined> }>;
  rateLimitNext(n: number): void;
  failNext(n: number): void;
  cut(runId: string): void;
  restart(): void;
  complete(runId: string): void;
  lastRun(): FakeRun | undefined;
  close(): Promise<void>;
};
const { startFakeGateway } = await import('../../../plugins/hermes-gateway/test/fake-gateway.mjs') as {
  startFakeGateway(options?: Record<string, unknown>): Promise<FakeGateway>;
};

const TYPE = 'hermes-gateway:gateway@1';
const DEFAULT_KEY = 'gateway-default-key-0001';
const CODER_KEY = 'gateway-coder-key-0002';
const FAST: Timing = { pollMs: 20, tickMs: 10, cancelGraceMs: 2_000, unreachableBudgetMs: 1_500, saveThrottleMs: 0 };

function connection(gw: FakeGateway, over: Partial<PluginUserConnection> = {}): PluginUserConnection {
  return {
    id: 'conn-1', pluginId: 'hermes-gateway', type: TYPE, identity: { ownerUserId: 'ada' } as PluginUserConnection['identity'],
    label: 'My gateway', url: gw.url, allowPrivateNetwork: true, config: {}, secrets: ['apiKey'],
    approval: 'approved', enabled: true, revision: 1, ...over,
  };
}

function connections(list: PluginUserConnection[], keys: Record<string, string> = { 'conn-1': DEFAULT_KEY }): Connections {
  return {
    forUser: async (owner) => (owner === 'ada' ? list : []),
    userSecret: async (_owner, id) => keys[id],
  };
}

function launch(owner: string | null = 'ada'): Launch {
  return { kind: 'mission', missionId: 'mission-1', ownerUserId: owner, agentName: 'hermes.default', project: null };
}

/** A daemon-side host: what the runner lends, with its own resume checks. */
/** An answer: Allow once (`true`), Deny (`false`), or Allow with a wider scope. */
type Answer = boolean | 'session' | 'always';

function fakeHost(answers: Answer[] = []) {
  const emitted: NormalizedEvent[] = [];
  const saved: Array<RemoteResumeState | null> = [];
  const asked: PermissionRequest[] = [];
  const waiting: Array<(allow: boolean) => void> = [];
  return {
    emitted, saved, asked, waiting,
    host: {
      emit: (ev: NormalizedEvent) => { emitted.push(ev); },
      end: () => undefined,
      // The daemon refuses a state that carries a credential of the profile:
      // the keys are passed here as if they were in its env.
      saveResume: (state: RemoteResumeState | null) => {
        saved.push(state ? JSON.parse(serializeResumeState(state, [DEFAULT_KEY, CODER_KEY])) as RemoteResumeState : null);
      },
      requestPermission: (req: PermissionRequest) => {
        asked.push(req);
        if (answers.length > 0) {
          const answer = answers.shift()!;
          return Promise.resolve(typeof answer === 'boolean' ? { allow: answer } : { allow: true, scope: answer });
        }
        return new Promise<{ allow: boolean }>((resolve) => { waiting.push((allow) => resolve({ allow })); });
      },
    },
  };
}

/** A fetch a test can cut, as a daemon that dies cuts every socket at once. */
function killableFetch() {
  const controller = new AbortController();
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (controller.signal.aborted) return Promise.reject(new TypeError('fetch failed'));
    const signals = [controller.signal, ...(init?.signal ? [init.signal] : [])];
    return globalThis.fetch(input, { ...init, signal: AbortSignal.any(signals) });
  };
  return { fetch, kill: () => controller.abort() };
}

function open(gw: FakeGateway, options: {
  conns?: Connections; model?: string | null; owner?: string | null; resume?: RemoteSessionResume;
  resumeSession?: string | null; answers?: Answer[]; timing?: Timing; fetch?: typeof globalThis.fetch;
} = {}) {
  const conns = options.conns ?? connections([connection(gw)]);
  const dialect = plugin.createHermesDialect({
    fetch: options.fetch ?? globalThis.fetch,
    resolveTarget: (l, model) => plugin.resolveTarget(conns, TYPE, l, model),
    timing: { ...FAST, ...options.timing },
  });
  const fake = fakeHost(options.answers);
  const driver: SessionDriver = dialect.openSession({
    spawn: {
      agentName: 'hermes.default', systemPrompt: 'You are terse.', message: '', resumeSession: options.resumeSession ?? null,
      cfg: { model: options.model === undefined ? 'hermes/default' : options.model ?? undefined } as never, missionId: 'mission-1',
    },
    host: fake.host,
    profileId: 'hermes-gateway',
    env: {},
    launch: launch(options.owner === undefined ? 'ada' : options.owner),
    ...(options.resume ? { resume: options.resume } : {}),
  });
  return { driver, dialect, ...fake };
}

const texts = (events: NormalizedEvent[]) => events
  .filter((e) => e.type === 'assistant')
  .flatMap((e) => ((e.payload as { message: { content: Array<{ type: string; text?: string }> } }).message.content))
  .filter((b) => b.type === 'text').map((b) => b.text);
const results = (events: NormalizedEvent[]) => events.filter((e) => e.type === 'result').map((e) => e.payload as Record<string, unknown>);
const blocks = (events: NormalizedEvent[], type: string) => events
  .filter((e) => e.type === 'assistant' || e.type === 'user')
  .flatMap((e) => ((e.payload as { message: { content: Array<Record<string, unknown>> } }).message.content))
  .filter((b) => b.type === type);

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withGateway(options: Record<string, unknown>, fn: (gw: FakeGateway) => Promise<void>): Promise<void> {
  const gw = await startFakeGateway(options);
  try { await fn(gw); } finally { await gw.close(); }
}

for (const version of ['0.21.0', '0.21.6']) {
  test(`[${version}] a text turn: init, deltas, the answer, the result`, () => withGateway({ version }, async (gw) => {
    const { driver, dialect, emitted, saved } = open(gw);
    assert.equal(driver.info, null);
    assert.equal(emitted.length, 0, 'nothing before start()');
    const info = await driver.start();
    assert.match(info.sessionId, /^rooks-/);
    assert.equal(info.resumed, false);
    assert.deepEqual(info.capabilities, { loadSession: false, resume: true, mcp: false, image: false });
    const init = emitted[0]!;
    assert.equal(dialect.extractSessionId(init), info.sessionId);
    assert.equal((init.payload as { backend: string }).backend, 'hermes-gateway');

    const outcome = await driver.prompt('hello there');
    assert.equal(outcome.stopReason, 'end_turn');
    assert.ok(emitted.some((e) => e.type === 'assistant_delta'), 'deltas stream');
    assert.deepEqual(texts(emitted), ['Hello from the fake model.'], 'the answer once, never the reasoning.available echo twice');
    const [result] = results(emitted);
    assert.equal(result?.subtype, 'success');
    assert.equal(result?.is_error, false);
    assert.equal(result?.result, 'Hello from the fake model.');
    assert.deepEqual(result?.usage, { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    assert.equal(emitted.at(-1)?.type, 'result', 'the result is the last line, before prompt resolves');
    assert.ok(!emitted.some((e) => JSON.stringify(e).includes('thinking')), 'no thinking block from reasoning.available');

    const run = gw.lastRun()!;
    assert.equal(run.sessionKey, 'rooks:ada', 'one Hermes memory per Rooks account');
    assert.equal(run.body.session_id, info.sessionId);
    assert.equal(run.body.instructions, 'You are terse.');
    const post = gw.requests.find((r) => r.method === 'POST' && r.path === '/v1/runs')!;
    assert.match(String(post.headers['idempotency-key']), /^rooks-/);
    // The resume state: never the key, never the URL; run id during the turn, cleared after.
    assert.ok(saved.length > 0);
    for (const state of saved) {
      assert.deepEqual(Object.keys(state ?? {}).sort(), ['lastSeq', 'runId', 'sessionId']);
      assert.doesNotMatch(JSON.stringify(state), /127\.0\.0\.1|gateway-default-key/);
    }
    assert.ok(saved.some((s) => s?.runId === run.id));
    assert.equal(saved.at(-1)?.runId, null);
    driver.close();
  }));

  test(`[${version}] a tool turn: interim text, tool_use / tool_result from tool.started / completed`, () => withGateway({ version }, async (gw) => {
    const { driver, emitted } = open(gw);
    await driver.start();
    await driver.prompt('use a tool please');
    const uses = blocks(emitted, 'tool_use');
    const outputs = blocks(emitted, 'tool_result');
    assert.equal(uses.length, 1);
    assert.equal(uses[0]!.name, 'terminal');
    assert.deepEqual(uses[0]!.input, { preview: 'echo hi' });
    assert.equal(outputs[0]!.tool_use_id, uses[0]!.id);
    assert.equal(outputs[0]!.is_error, false);
    assert.deepEqual(texts(emitted), ['Let me check that first.', 'Done: hi']);
    driver.close();
  }));

  test(`[${version}] approval: once → the run goes on; the card names the command`, () => withGateway({ version }, async (gw) => {
    const { driver, emitted, asked } = open(gw, { answers: [true] });
    await driver.start();
    const outcome = await driver.prompt('approve this cleanup');
    assert.equal(outcome.stopReason, 'end_turn');
    assert.equal(asked.length, 1, 'one card per request id');
    assert.equal(asked[0]!.toolCallId, '58f6f13b');
    assert.equal(asked[0]!.tool, 'terminal');
    assert.equal((asked[0]!.input as { command: string }).command, 'mkdir -p /tmp/probe && rm -rf /tmp/probe');
    assert.deepEqual(gw.lastRun()!.approvals, [{ choice: 'once', request_id: '58f6f13b' }]);
    assert.deepEqual(texts(emitted), ['Cleaned up.']);
    driver.close();
  }));

  test(`[${version}] approval: the card offers session and always, and the chosen scope reaches the gateway`, () => withGateway({ version }, async (gw) => {
    const { driver, asked } = open(gw, { answers: ['session'] });
    await driver.start();
    await driver.prompt('approve this cleanup');
    assert.deepEqual(asked[0]!.scopes, ['session', 'always']);
    assert.deepEqual(gw.lastRun()!.approvals, [{ choice: 'session', request_id: '58f6f13b' }]);
    driver.close();
  }));

  test(`[${version}] steer: the instruction reaches the run that is going on, and nothing is sent once it ended`, () => withGateway({ version }, async (gw) => {
    const { driver, saved } = open(gw);
    await driver.start();
    assert.equal(await driver.steer('too early'), false, 'no turn yet: nothing to redirect');
    const turn = driver.prompt('slow please');
    // The gateway knows the run before its 202 reaches the driver: wait until
    // the driver holds the run id too (it saves it at once), or steer has no target.
    await until(() => {
      const run = gw.lastRun();
      return run?.status === 'running' && saved.some((s) => s?.runId === run.id);
    }, 'the run started and the driver knows it');
    assert.equal(await driver.steer('also mention the tests'), true);
    assert.deepEqual(gw.lastRun()!.steers, ['also mention the tests']);
    await driver.cancel();
    await turn;
    assert.equal(await driver.steer('too late'), false);
    assert.deepEqual(gw.lastRun()!.steers, ['also mention the tests']);
    driver.close();
  }));

  test(`[${version}] approval: deny → the tool is blocked, the run still completes`, () => withGateway({ version }, async (gw) => {
    const { driver, emitted } = open(gw, { answers: [false] });
    await driver.start();
    const outcome = await driver.prompt('approve this cleanup');
    assert.equal(outcome.stopReason, 'end_turn');
    assert.deepEqual(gw.lastRun()!.approvals, [{ choice: 'deny', request_id: '58f6f13b' }]);
    const [blocked] = blocks(emitted, 'tool_result');
    assert.equal(blocked!.is_error, true);
    assert.match(String(blocked!.content), /BLOCKED/);
    assert.equal(results(emitted)[0]?.subtype, 'success');
    driver.close();
  }));

  test(`[${version}] STOP: the run is stopped, the turn ends cancelled, the session goes on`, () => withGateway({ version }, async (gw) => {
    const { driver, emitted } = open(gw);
    await driver.start();
    const pending = driver.prompt('a slow one');
    await until(() => gw.lastRun()?.status === 'running' && emitted.some((e) => e.type === 'assistant_delta'), 'the run to stream');
    await driver.cancel();
    const outcome = await pending;
    assert.equal(outcome.stopReason, 'cancelled');
    assert.equal(gw.lastRun()!.stopped, true);
    assert.equal(results(emitted).at(-1)?.subtype, 'cancelled');
    assert.equal(emitted.at(-1)?.type, 'result');
    // The session goes on.
    assert.equal((await driver.prompt('hello again')).stopReason, 'end_turn');
    driver.close();
  }));

  test(`[${version}] the gateway restarts under a turn: interrupted, with a readable reason and the partial text`, () => withGateway({ version }, async (gw) => {
    const { driver, emitted } = open(gw);
    await driver.start();
    const pending = driver.prompt('a slow one');
    await until(() => emitted.some((e) => e.type === 'assistant_delta'), 'the first delta');
    gw.restart();
    const outcome = await pending;
    assert.equal(outcome.stopReason, 'interrupted');
    const [result] = results(emitted);
    assert.equal(result?.is_error, true);
    assert.match(String(result?.error), /restarted and interrupted/);
    assert.deepEqual(texts(emitted), ['Hello '], 'what Hermes kept of the answer is shown');
    driver.close();
  }));

  test(`[${version}] reattach after a daemon restart: the second driver finishes the turn`, () => withGateway({ version }, async (gw) => {
    const first = killableFetch();
    const a = open(gw, { fetch: first.fetch });
    const info = await a.driver.start();
    const pending = a.driver.prompt('a slow one').catch((err: unknown) => err);
    await until(() => a.emitted.some((e) => e.type === 'assistant_delta') && (a.saved.at(-1)?.runId ?? null) !== null, 'the run to be saved');
    // The daemon dies: every socket is cut, nobody calls close().
    first.kill();
    const state = a.saved.at(-1)!;
    const b = open(gw, { resumeSession: info.sessionId, resume: { state, turnActive: true } });
    const resumed = await b.driver.start();
    assert.equal(resumed.sessionId, info.sessionId);
    assert.equal(resumed.resumed, true);
    assert.ok(!b.emitted.some((e) => e.type === 'system'), 'no second system:init');
    gw.complete(gw.lastRun()!.id);
    await until(() => results(b.emitted).length === 1, 'the reattached result');
    assert.equal(results(b.emitted)[0]?.subtype, 'success');
    assert.equal(texts(b.emitted).at(-1), 'Hello finished.');
    assert.equal(results(a.emitted).length, 0, 'the dead daemon\'s driver emits nothing more');
    await pending;
    b.driver.close();
  }));

  test(`[${version}] reattach under a pending approval: the card is raised again`, () => withGateway({ version }, async (gw) => {
    const first = killableFetch();
    const a = open(gw, { fetch: first.fetch });
    const info = await a.driver.start();
    void a.driver.prompt('approve this cleanup').catch(() => undefined);
    await until(() => a.asked.length === 1 && gw.lastRun()?.status === 'waiting_for_approval', 'the first card');
    first.kill();
    const b = open(gw, { resumeSession: info.sessionId, resume: { state: a.saved.at(-1)!, turnActive: true }, answers: [true] });
    await b.driver.start();
    await until(() => results(b.emitted).length === 1, 'the run to complete after the new answer');
    assert.equal(b.asked[0]?.toolCallId, '58f6f13b');
    assert.deepEqual(gw.lastRun()!.approvals, [{ choice: 'once', request_id: '58f6f13b' }]);
    b.driver.close();
  }));

  test(`[${version}] a terminal frame lost on the stream: the watchdog asks the status`, () => withGateway({ version, keepaliveMs: 20 }, async (gw) => {
    const { driver, emitted } = open(gw, { timing: { watchdogMs: 150 } });
    await driver.start();
    const outcome = await driver.prompt('lost frame');
    assert.equal(outcome.stopReason, 'end_turn');
    assert.deepEqual(texts(emitted), ['Hello from the fake model.']);
    driver.close();
  }));
}

test('[0.21.6] a cut stream resumes with Last-Event-ID, without repeating a delta', () => withGateway({ version: '0.21.6' }, async (gw) => {
  const { driver, emitted } = open(gw);
  await driver.start();
  const pending = driver.prompt('a long one');
  await until(() => emitted.filter((e) => e.type === 'assistant_delta').length >= 10, 'ten deltas');
  gw.cut(gw.lastRun()!.id);
  assert.equal((await pending).stopReason, 'end_turn');
  const deltas = emitted.filter((e) => e.type === 'assistant_delta').map((e) => (e.payload as { text: string }).text);
  assert.equal(deltas.length, 30, 'every delta once');
  assert.equal(new Set(deltas).size, 30);
  const reconnect = gw.requests.filter((r) => r.path.endsWith('/events')).at(-1)!;
  assert.ok(reconnect.headers['last-event-id'] !== undefined, 'the reconnection names the last event seen');
  driver.close();
}));

test('[0.21.0] a cut stream cannot be read again: the turn polls the status and takes the final answer', () => withGateway({ version: '0.21.0' }, async (gw) => {
  const { driver, emitted } = open(gw);
  await driver.start();
  const pending = driver.prompt('a long one');
  await until(() => emitted.filter((e) => e.type === 'assistant_delta').length >= 10, 'ten deltas');
  gw.cut(gw.lastRun()!.id);
  assert.equal((await pending).stopReason, 'end_turn');
  assert.match(texts(emitted).at(-1) ?? '', /^w0 w1 .* w29 $/, 'the run status output is the answer');
  driver.close();
}));

test('sub-agents become cards, never the forbidden Task / Agent tools', () => withGateway({}, async (gw) => {
  const { driver, emitted } = open(gw);
  await driver.start();
  await driver.prompt('delegate to a subagent');
  const [use] = blocks(emitted, 'tool_use');
  assert.equal(use!.name, 'hermes_subagent');
  assert.equal(use!.id, 'sa-0-0ab72014');
  assert.equal((use!.input as { description: string }).description, 'Say hello to the user');
  const [done] = blocks(emitted, 'tool_result');
  assert.equal(done!.tool_use_id, 'sa-0-0ab72014');
  assert.equal(done!.content, 'Said hello.');
  driver.close();
}));

test('a wrong key: start() refuses with a readable reason that never quotes the key', () => withGateway({}, async (gw) => {
  const { driver, emitted } = open(gw, { conns: connections([connection(gw)], { 'conn-1': 'not-the-right-key-123' }) });
  await assert.rejects(driver.start(), (err: Error) => /refused the API key/.test(err.message) && !err.message.includes('not-the-right-key'));
  assert.equal(emitted.length, 0);
  driver.close();
}));

test('a profile is reached under /p/<profile>/ with its own key', () => withGateway({}, async (gw) => {
  const coder = connection(gw, { id: 'conn-2', config: { profile: 'coder' } });
  const conns = connections([connection(gw), coder], { 'conn-1': DEFAULT_KEY, 'conn-2': CODER_KEY });
  const { driver } = open(gw, { conns, model: 'hermes/coder' });
  await driver.start();
  await driver.prompt('hello coder');
  assert.equal(gw.lastRun()!.profile, 'coder');
  assert.ok(gw.requests.some((r) => r.path === '/p/coder/v1/runs'));
  driver.close();
  // A profile nobody connected: said, not guessed.
  const missing = open(gw, { conns, model: 'hermes/writer' });
  await assert.rejects(missing.driver.start(), /profile "writer"/);
}));

test('two gateways serving the same profile: each pinned model reaches ITS gateway, the old model the first one', async () => {
  const home = await startFakeGateway({ key: 'home-key-000000000001' });
  const work = await startFakeGateway({ key: 'work-key-000000000002' });
  try {
    const list = [
      connection(home, { id: 'conn-home', label: 'Home' }),
      connection(work, { id: 'conn-work', label: 'Work' }),
    ];
    const conns = connections(list, { 'conn-home': 'home-key-000000000001', 'conn-work': 'work-key-000000000002' });
    for (const [model, reached, idle] of [
      ['hermes/conn-work/default', work, home],
      ['hermes/conn-home/default', home, work],
    ] as const) {
      const before = idle.runs.size;
      const { driver } = open(reached, { conns, model });
      await driver.start();
      assert.equal((await driver.prompt('hello')).stopReason, 'end_turn');
      assert.equal(reached.lastRun()!.sessionKey, 'rooks:ada');
      assert.equal(idle.runs.size, before, `${model} never reaches the other gateway`);
      driver.close();
    }
    // The shared door of before: same resolution, the first usable connection.
    const runs = work.runs.size;
    const legacy = open(home, { conns, model: 'hermes/default' });
    await legacy.driver.start();
    await legacy.driver.prompt('hello');
    assert.equal(home.runs.size, 2);
    assert.equal(work.runs.size, runs);
    legacy.driver.close();
    // The first one turned off: the door goes to the next, the pinned agent says why it cannot.
    const off = connections([{ ...list[0]!, enabled: false }, list[1]!], { 'conn-home': 'home-key-000000000001', 'conn-work': 'work-key-000000000002' });
    const door = open(work, { conns: off, model: 'hermes/default' });
    await door.driver.start();
    await door.driver.prompt('hello');
    assert.equal(work.runs.size, runs + 1);
    door.driver.close();
    const pinned = open(home, { conns: off, model: 'hermes/conn-home/default' });
    await assert.rejects(pinned.driver.start(), /turned off/);
  } finally {
    await home.close();
    await work.close();
  }
});

test('a pinned connection: another account\'s, deleted or now serving another profile is refused, without a URL or a key', () => withGateway({}, async (gw) => {
  const conns = connections([connection(gw, { id: 'conn-home', label: 'Home' })], { 'conn-home': DEFAULT_KEY });
  const leaks = (err: Error) => /127\.0\.0\.1|gateway-default-key/.test(err.message);
  const requests = gw.requests.length;
  // Bob launches Ada's pinned agent: refused, and nothing reaches Ada's gateway.
  const bob = open(gw, { conns, model: 'hermes/conn-home/default', owner: 'bob' });
  await assert.rejects(bob.driver.start(), (err: Error) => /it was deleted, or it belongs to another account/.test(err.message) && !leaks(err));
  // Ada deleted the connection: the same words, which never tell whose it is.
  const gone = open(gw, { conns, model: 'hermes/conn-deleted/default' });
  await assert.rejects(gone.driver.start(), (err: Error) => /it was deleted, or it belongs to another account/.test(err.message) && !leaks(err));
  const none = open(gw, { conns: connections([]), model: 'hermes/conn-home/default' });
  await assert.rejects(none.driver.start(), /it was deleted, or it belongs to another account/);
  assert.equal(gw.requests.length, requests);
  // The connection now serves another profile: re-create the agents.
  const moved = open(gw, { conns, model: 'hermes/conn-home/coder' });
  await assert.rejects(moved.driver.start(), (err: Error) => /"Home" now serves the profile "default", not "coder"/.test(err.message) && !leaks(err));
  const pending = open(gw, { conns: connections([connection(gw, { id: 'conn-home', approval: 'pending' })]), model: 'hermes/conn-home/default' });
  await assert.rejects(pending.driver.start(), /waiting for an administrator/);
}));

test('model slugs: the shared door, the pinned connection, and what is neither', () => {
  assert.deepEqual(plugin.parseModel('hermes/default'), { profile: 'default', connectionId: null });
  assert.deepEqual(plugin.parseModel('hermes/coder'), { profile: 'coder', connectionId: null });
  assert.deepEqual(plugin.parseModel('hermes/6f1c2a9e-1b2c-4d5e-8f90-123456789abc/coder'), { profile: 'coder', connectionId: '6f1c2a9e-1b2c-4d5e-8f90-123456789abc' });
  // Not a profile a connection can serve: refused as an unknown profile, as before.
  assert.deepEqual(plugin.parseModel('hermes/a/b/c'), { profile: 'a/b/c', connectionId: null });
  assert.deepEqual(plugin.parseModel('hermes/a/../b'), { profile: 'a/../b', connectionId: null });
  assert.equal(plugin.parseModel('hermes/'), null);
  assert.equal(plugin.parseModel('gpt-5.5'), null);
});

test('429: the message waits for a free slot, then goes; past the budget the turn says so', () => withGateway({ retryAfter: '0' }, async (gw) => {
  const { driver, emitted } = open(gw);
  await driver.start();
  gw.rateLimitNext(2);
  assert.equal((await driver.prompt('hello')).stopReason, 'end_turn');
  assert.equal(gw.runs.size, 1, 'one run for three POSTs');
  const keys = gw.requests.filter((r) => r.method === 'POST' && r.path === '/v1/runs').map((r) => r.headers['idempotency-key']);
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 1, 'the same Idempotency-Key on every attempt');
  driver.close();

  const busy = open(gw, { timing: { rateLimitBudgetMs: 50 } });
  await busy.driver.start();
  gw.rateLimitNext(1_000);
  assert.equal((await busy.driver.prompt('hello')).stopReason, 'error');
  assert.match(String(results(busy.emitted).at(-1)?.error), /as many tasks as it allows/);
  assert.equal(results(emitted).length, 1);
  busy.driver.close();
}));

test('a 503 on submission is retried with the same key', () => withGateway({}, async (gw) => {
  const { driver } = open(gw);
  await driver.start();
  gw.failNext(2);
  assert.equal((await driver.prompt('hello')).stopReason, 'end_turn');
  assert.equal(gw.runs.size, 1);
  driver.close();
}));

test('a gateway too old for the floor is refused at start, naming the version to install', () => withGateway({
  features: { run_submission: true, run_events_sse: true, run_status: true, run_stop: true, run_approval_response: true, runs_idempotency: { supported: true, durable: false } },
}, async (gw) => {
  const { driver } = open(gw);
  await assert.rejects(driver.start(), (err: Error) => /too old/.test(err.message) && /0\.21\.0/.test(err.message) && /run_steer/.test(err.message));
}));

test('no connection, or no account behind the mission: start() says what to do', () => withGateway({}, async (gw) => {
  const none = open(gw, { conns: connections([]) });
  await assert.rejects(none.driver.start(), /No Hermes gateway is configured for your account: add one in Settings › Secrets › Connections/);
  const orphan = open(gw, { owner: null });
  await assert.rejects(orphan.driver.start(), /not launched by an account/);
  const pending = open(gw, { conns: connections([connection(gw, { approval: 'pending' })]) });
  await assert.rejects(pending.driver.start(), /waiting for an administrator/);
}));

test('an unusable resume state makes start() fail readably', () => withGateway({}, async (gw) => {
  const gone = open(gw, { resume: { state: { runId: 'run_unknown', sessionId: 's1', lastSeq: 3 }, turnActive: true } });
  await assert.rejects(gone.driver.start(), /no longer knows the run/);
  const broken = open(gw, { resume: { state: { lastSeq: 3 }, turnActive: true } });
  await assert.rejects(broken.driver.start(), /unreadable/);
  // A daemon that died between sending a message and its admission: said, not replayed.
  const lost = open(gw, { resume: { state: { runId: null, sessionId: 's1', lastSeq: -1 }, turnActive: true } });
  await lost.driver.start();
  assert.match(String(results(lost.emitted)[0]?.error), /may not have arrived|cannot tell whether it arrived/);
}));

test('close() under a turn stops the run, rejects the prompt and emits nothing more', () => withGateway({}, async (gw) => {
  const { driver, emitted } = open(gw);
  await driver.start();
  const pending = driver.prompt('a slow one');
  await until(() => emitted.some((e) => e.type === 'assistant_delta'), 'the first delta');
  const at = emitted.length;
  driver.close();
  await assert.rejects(pending);
  await until(() => gw.lastRun()!.stopped, 'the remote run to be stopped');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(emitted.length, at);
  await assert.rejects(driver.prompt('after close'));
}));

test('a known session is reopened; images are announced as not sent', () => withGateway({}, async (gw) => {
  const first = open(gw);
  const info = await first.driver.start();
  await first.driver.prompt('hello');
  first.driver.close();
  const again = open(gw, { resumeSession: info.sessionId });
  const reopened = await again.driver.start();
  assert.equal(reopened.resumed, true);
  assert.equal(reopened.sessionId, info.sessionId);
  await again.driver.prompt('look at this', [{ media_type: 'image/png', data: 'AAAA' }]);
  assert.match(texts(again.emitted)[0] ?? '', /image\(s\) not sent/);
  again.driver.close();
  const unknown = open(gw, { resumeSession: 'rooks-never-seen' });
  assert.equal((await unknown.driver.start()).resumed, false);
  unknown.driver.close();
}));
