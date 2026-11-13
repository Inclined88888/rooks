/**
 * An ACP agent's own blocking requests (`AcpAgentSpec.extensionRequests`), end to end over in-memory pipes: the
 * agent asks, the provider's handler opens a card through `SessionHost.ask`, the agent gets the provider's reply.
 * The agent here is an invented one (`acme/…`): the hook names no vendor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionAskOutcome, SessionAskRequest, SessionHost } from '../types.js';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'rooks-acp-ext-'));
process.env.ROOKS_HOME = TMP_HOME;
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { AcpSessionDriver } = await import('./driver.js');
const { defineProvider } = await import('./provider.js');
const { acpExtensionCards, acpExtensionMethodProblem, PLAN_APPROVE_LABEL, PLAN_REJECT_LABEL } = await import('./extensions.js');
const { createAcpReplayPeer } = await import('../../../../packages/sdk/src/testing/acp-checks.js');
type Handler = import('./extensions.js').AcpExtensionHandler;
type Step = import('../../../../packages/sdk/src/testing/acp-checks.js').AcpScriptStep;

const INIT: Step = { on: 'initialize', reply: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } };
const NEW: Step = { on: 'session/new', reply: { sessionId: 's-1' } };

/** A pick question in the agent's own shape, answered in its own shape. */
const pick: Handler = async (params, cards) => {
  const p = params as { callId: string; prompt: string; choices: Array<{ key: string; text: string }> };
  const got = await cards.ask([{ id: 'q', question: p.prompt, options: p.choices.map((c) => ({ id: c.key, label: c.text })) }], { id: p.callId });
  if (got.outcome === 'answered') return { status: 'ok', keys: got.value.q!.selected, remark: got.value.q!.text };
  return got.outcome === 'cancelled' ? { status: 'cancelled' } : { status: 'skipped', why: got.reason };
};

const plan: Handler = async (params, cards) => {
  const p = params as { title: string; body: string };
  const got = await cards.approvePlan({ title: p.title, plan: p.body, steps: ['read', 'write'] });
  if (got.outcome !== 'answered') return { status: got.outcome };
  return { status: got.value.approved ? 'accepted' : 'rejected', note: got.value.note };
};

function script(requests: Array<{ id: string; method: string; params: unknown }>): Step[] {
  return [INIT, NEW, { on: 'session/prompt', send: requests, reply: { stopReason: 'end_turn' } }];
}

function rig(steps: Step[], ask: SessionHost['ask'], handlers: Record<string, Handler> = { 'acme/pick': pick, 'acme/plan': plan }) {
  const peer = createAcpReplayPeer(steps);
  const driver = new AcpSessionDriver({
    io: peer.io,
    host: { emit: () => undefined, requestPermission: async () => ({ allow: false }), ...(ask ? { ask } : {}) },
    cwd: TMP_HOME, systemPrompt: '', model: null, resumeSession: null, mcpServers: async () => [],
    permissionsByAgent: false, profileId: 'acme', extensionRequests: handlers,
  });
  return { peer, driver, close: () => { driver.close(); peer.close(); } };
}

const PICK = { id: 'x1', method: 'acme/pick', params: { callId: 'call-7', prompt: 'Which mode?', choices: [{ key: 'a', text: 'Agent' }, { key: 'p', text: 'Plan' }] } };

test('a question the agent asks opens a card, and the agent gets the answer in its own shape', async () => {
  const asked: SessionAskRequest[] = [];
  const r = rig(script([PICK]), async (req) => {
    asked.push(req);
    return { answered: true, answers: { 'Which mode?': { picked: ['Plan'], text: 'quickly' } } };
  });
  try {
    await r.driver.start();
    assert.equal((await r.driver.prompt('go')).stopReason, 'end_turn');
    assert.deepEqual(asked, [{ id: 'call-7', questions: [{ question: 'Which mode?', options: [{ label: 'Agent' }, { label: 'Plan' }] }] }]);
    assert.deepEqual(r.peer.answer('x1'), { status: 'ok', keys: ['p'], remark: 'quickly' });
  } finally {
    r.close();
  }
});

test('a plan goes to the person as one card with its steps; approve and reject come back with the remark', async () => {
  const shown: string[] = [];
  const answer = (label: string, text: string | null) => async (req: SessionAskRequest): Promise<SessionAskOutcome> => {
    shown.push(req.questions[0]!.question);
    assert.deepEqual(req.questions[0]!.options?.map((o) => o.label), [PLAN_APPROVE_LABEL, PLAN_REJECT_LABEL]);
    return { answered: true, answers: { [req.questions[0]!.question]: { picked: [label], text } } };
  };
  const PLAN = { id: 'x2', method: 'acme/plan', params: { title: 'Refactor', body: '1. look\n2. change' } };
  for (const [label, text, reply] of [
    [PLAN_APPROVE_LABEL, null, { status: 'accepted', note: null }],
    [PLAN_REJECT_LABEL, 'not now', { status: 'rejected', note: 'not now' }],
  ] as const) {
    const r = rig(script([PLAN]), answer(label, text));
    try {
      await r.driver.start();
      await r.driver.prompt('go');
      assert.deepEqual(r.peer.answer('x2'), reply);
    } finally {
      r.close();
    }
  }
  assert.equal(shown[0], 'Refactor\n\n1. look\n2. change\n\n- read\n- write');
});

test('nobody to ask (a one-shot host) or a refusal: the agent is answered at once, with the reason', async () => {
  const none = rig(script([PICK]), undefined);
  try {
    await none.driver.start();
    await none.driver.prompt('go');
    assert.deepEqual(none.peer.answer('x1'), { status: 'skipped', why: 'nobody can answer a question in this session' });
  } finally {
    none.close();
  }
  const refused = rig(script([PICK]), async () => ({ answered: false, reason: 'This mission runs unattended: decide yourself.' }));
  try {
    await refused.driver.start();
    await refused.driver.prompt('go');
    assert.deepEqual(refused.peer.answer('x1'), { status: 'skipped', why: 'This mission runs unattended: decide yourself.' });
  } finally {
    refused.close();
  }
});

test('a method the provider does not handle keeps "method not found"; a handler that throws is answered with a generic error', async () => {
  const boom: Handler = async () => { throw new Error('secret detail'); };
  const r = rig(script([{ id: 'x3', method: 'acme/other', params: {} }, { id: 'x4', method: 'acme/boom', params: {} }]), undefined, { 'acme/boom': boom });
  try {
    await r.driver.start();
    await r.driver.prompt('go');
    const replies = r.peer.received.filter((m) => m.id === 'x3' || m.id === 'x4');
    assert.equal((replies[0]!.error as { code: number }).code, -32601);
    assert.equal((replies[1]!.error as { code: number }).code, -32603);
    assert.doesNotMatch(JSON.stringify(replies[1]), /secret detail/);
  } finally {
    r.close();
  }
});

test('a cancelled turn tells the handler to stop waiting; the card is retired and the agent gets the provider\'s cancelled reply', async () => {
  let retired: AbortSignal | undefined;
  const r = rig(script([PICK]), (_req, wait) => new Promise<SessionAskOutcome>((resolve) => {
    retired = wait?.signal;
    wait?.signal?.addEventListener('abort', () => resolve({ answered: false, reason: 'gone' }), { once: true });
  }));
  try {
    await r.driver.start();
    const turn = r.driver.prompt('go');
    while (!retired) await new Promise((resolve) => setImmediate(resolve));
    await r.driver.cancel();
    await turn;
    assert.equal(retired.aborted, true);
    for (let i = 0; i < 50 && r.peer.answer('x1') === undefined; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(r.peer.answer('x1'), { status: 'cancelled' });
  } finally {
    r.close();
  }
});

test('the cards check the ids the agent uses before any card opens', async () => {
  let opened = 0;
  const cards = acpExtensionCards(async () => { opened += 1; return { answered: false, reason: 'x' }; }, new AbortController().signal);
  const twice = await cards.ask([{ id: 'q', question: 'A?' }, { id: 'q', question: 'B?' }]);
  assert.deepEqual(twice, { outcome: 'unanswered', reason: 'the question cannot be shown: question 2: the same id as an earlier question' });
  const options = await cards.ask([{ id: 'q', question: 'A?', options: [{ id: 'o', label: 'x' }, { id: 'o', label: 'y' }] }]);
  assert.match(options.outcome === 'unanswered' ? options.reason : '', /option 2: the same id/);
  assert.equal(opened, 0);
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await acpExtensionCards(async () => ({ answered: false, reason: 'x' }), aborted.signal).ask([{ id: 'q', question: 'A?' }]), { outcome: 'cancelled' });
});

test('a provider extends the protocol, never takes over its methods', () => {
  for (const method of ['session/prompt', 'session/request_permission', 'fs/read_text_file', 'terminal/create', 'initialize', 'authenticate', '', 'has space', 'x'.repeat(121)]) {
    assert.notEqual(acpExtensionMethodProblem(method), null, method);
  }
  for (const method of ['acme/ask_question', '_acme/plan', 'vendor.method']) assert.equal(acpExtensionMethodProblem(method), null, method);
  const services = { mcp: async () => ({ servers: [] }) } as unknown as Parameters<typeof defineProvider>[0];
  const spec = { id: 'acme', args: ['acp'], binary: { names: ['acme-agent'] } };
  assert.throws(() => defineProvider(services, { ...spec, extensionRequests: { 'session/prompt': pick } }), /belongs to the protocol itself/);
  assert.doesNotThrow(() => defineProvider(services, { ...spec, extensionRequests: { 'acme/pick': pick } }));
});
