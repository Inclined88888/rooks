/**
 * The conformance checks of an ACP provider, which a transcript cannot carry: an ACP agent is a conversation (the
 * daemon asks, the agent answers, and sometimes asks back), not a stream to replay. A session is therefore recorded
 * as a SCRIPT — one JSON object per line, the agent's side of the conversation, keyed by the request that triggers
 * it — and `createAcpReplayPeer` plays that agent over in-memory pipes against the session driver the daemon runs.
 *
 *   {"on":"initialize","reply":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[]}}
 *   {"on":"session/new","reply":{"sessionId":"abc"}}
 *   {"on":"session/prompt","send":[{"method":"session/update","params":{…}}],"reply":{"stopReason":"end_turn"}}
 *
 * `send` is what the agent writes before it answers. An item with an `id` is a request to the daemon (a
 * `session/request_permission`): the peer waits for the daemon's answer before going on, and keeps it.
 * A method with no step left is answered "method not found", as a real agent does.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import {
  ASSISTANT_DELTA, type Backend, type BuildSpawnOpts, type NormalizedEvent, type PermissionDecision, type PermissionRequest,
  type ProviderConversation, type SessionAskOutcome, type SessionAskRequest, type SessionDriver, type SessionHost, type SessionStdio,
} from '../provider.js';
import { DEFAULT_MESSAGE, spawnOptions } from './line-checks.js';
import type { ConformanceCheck, ConformanceContext } from './types.js';

export type AcpScriptMessage = {
  readonly method: string;
  readonly params?: unknown;
  /** Present = a request to the daemon: the peer waits for its answer. Absent = a notification. */
  readonly id?: string | number;
};

export type AcpScriptStep = {
  /** The method of the daemon's request that triggers this step; a repeated method consumes its steps in order. */
  readonly on: string;
  readonly send?: readonly AcpScriptMessage[];
  readonly reply?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

export type AcpReplayPeer = {
  /** Hand these to the provider's `openSession`. */
  readonly io: SessionStdio;
  /** Every message the daemon wrote, parsed, in order. */
  readonly received: readonly Record<string, unknown>[];
  /** The daemon's answer (`result`) to the agent request that had this `id`, once it came. */
  answer(id: string | number): unknown;
  /** The same agent as a conversation, for `createProviderContext({ binaries: { 'my-cli': { converse: () => peer.conversation() } } })` (the model probe). */
  conversation(): ProviderConversation;
  close(): void;
};

/** A script as a file of one JSON object per line, or the text of one. */
export function loadAcpScript(source: string): AcpScriptStep[] {
  const text = source.includes('\n') || source.trimStart().startsWith('{') ? source : readFileSync(source, 'utf8');
  return text.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('//')).map((line, index) => {
    const step = JSON.parse(line) as AcpScriptStep;
    if (typeof step.on !== 'string') throw new Error(`ACP script line ${index + 1}: a step needs \`on\` (the daemon's method)`);
    return step;
  });
}

export function createAcpReplayPeer(script: readonly AcpScriptStep[]): AcpReplayPeer {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const received: Record<string, unknown>[] = [];
  const used = new Map<string, number>();
  const waiting = new Map<string | number, (result: unknown) => void>();
  const answers = new Map<string | number, unknown>();
  let buffer = '';

  const write = (message: Record<string, unknown>): void => { fromAgent.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };

  async function serve(id: string | number, method: string): Promise<void> {
    const count = used.get(method) ?? 0;
    used.set(method, count + 1);
    const step = script.filter((candidate) => candidate.on === method)[count];
    if (!step) return write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    for (const message of step.send ?? []) {
      if (message.id === undefined) { write({ method: message.method, params: message.params }); continue; }
      const answered = new Promise<unknown>((resolve) => waiting.set(message.id!, resolve));
      write({ id: message.id, method: message.method, params: message.params });
      await answered;
    }
    write(step.error ? { id, error: step.error } : { id, result: step.reply ?? null });
  }

  toAgent.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      received.push(message);
      const id = message.id as string | number | undefined;
      if (typeof message.method === 'string' && id !== undefined) void serve(id, message.method);
      else if (message.method === undefined && id !== undefined) {
        answers.set(id, message.result);
        waiting.get(id)?.(message.result);
        waiting.delete(id);
      }
    }
  });

  return {
    io: { stdin: toAgent, stdout: fromAgent },
    received,
    answer: (id) => answers.get(id),
    conversation: () => {
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        fromAgent.once('close', () => resolve({ code: 0, signal: null }));
      });
      return {
        pid: null,
        cwd: tmpdir(),
        write: (data) => { toAgent.write(data); },
        onData: (listener) => {
          const forward = (chunk: Buffer): void => listener(chunk);
          fromAgent.on('data', forward);
          return () => { fromAgent.off('data', forward); };
        },
        stderr: () => '',
        exited,
        stop: async () => { toAgent.destroy(); fromAgent.destroy(); await exited; },
      };
    },
    close: () => { toAgent.destroy(); fromAgent.destroy(); },
  };
}

export type AcpSessionExpectation = {
  /** The recorded session (see the header of this file): steps, the text of a `.jsonl` file, or its path. */
  readonly script: string | readonly AcpScriptStep[];
  /** The session id `session/new` answers in the script. */
  readonly sessionId: string;
  /** The binary `buildSpawn` launches, and the arguments that put it in ACP mode. */
  readonly cmd: string;
  readonly args: readonly string[];
  /** What the script's `session/prompt` streams as the assistant's text, in full. */
  readonly says: string;
  readonly stopReason: string;
  /** The MCP servers the session must declare to the agent (Timon's own, by name). */
  readonly mcpServers: readonly string[];
  /**
   * The script's tool use that asks permission (its `id`), and the option ids the agent offers for yes and no.
   * Skip it for an agent that decides alone (`permissionsByAgent`).
   */
  readonly permission?: { readonly requestId: string | number; readonly tool: string | RegExp; readonly allowOptionId: string; readonly denyOptionId: string };
  /** A script whose `session/new` answers `auth_required`: what the user must read. */
  readonly signIn?: { readonly script: string | readonly AcpScriptStep[]; readonly message: RegExp };
  /**
   * The agent's own blocking requests the provider answers (`AcpAgentSpec.extensionRequests`), each one a request
   * the script's `session/prompt` sends (`send` with an `id`).
   */
  readonly extensions?: readonly AcpExtensionExpectation[];
};

/** One of the agent's own blocking requests, played through a card the bench answers. */
export type AcpExtensionExpectation = {
  /** The session that sends the request (steps, the text of a `.jsonl` file, or its path); default the expectation's `script`. */
  readonly script?: string | readonly AcpScriptStep[];
  /** The request's `id` in the script. */
  readonly requestId: string | number;
  /** What the person does with the card: an answer keyed by question text, or `{ answered: false, reason }`. */
  readonly answer: (card: SessionAskRequest) => SessionAskOutcome;
  /** The `result` the agent must receive, in its own shape. */
  readonly reply: unknown;
  /** The `result` the agent must receive when nobody can be asked (a host without `ask`, a daemon one-shot). */
  readonly unanswered?: unknown;
};

const asSteps = (script: string | readonly AcpScriptStep[]): readonly AcpScriptStep[] => (typeof script === 'string' ? loadAcpScript(script) : script);

type Rig = {
  driver: SessionDriver;
  peer: AcpReplayPeer;
  events: NormalizedEvent[];
  asked: PermissionRequest[];
  spawn: BuildSpawnOpts;
  close(): void;
};

function open(provider: Backend, ctx: ConformanceContext, script: readonly AcpScriptStep[], allow: boolean, ask?: SessionHost['ask']): Rig {
  assert.ok(provider.openSession, 'an ACP provider drives its agent through a session: `openSession` is missing');
  const peer = createAcpReplayPeer(script);
  const events: NormalizedEvent[] = [];
  const asked: PermissionRequest[] = [];
  const spawn = spawnOptions(ctx, '', null);
  const driver = provider.openSession({
    io: peer.io,
    spawn,
    host: {
      emit: (event) => { events.push(event); },
      requestPermission: async (request): Promise<PermissionDecision> => { asked.push(request); return { allow }; },
      ...(ask ? { ask } : {}),
    },
    mcpEnv: { TIMON_API_TOKEN: 'timon-seal-00000000000000000000000000000000' },
  });
  return { driver, peer, events, asked, spawn, close: () => { driver.close(); peer.close(); } };
}

const said = (events: readonly NormalizedEvent[]): string =>
  events.filter((event) => event.type === ASSISTANT_DELTA).map((event) => (event.payload as { text?: string }).text ?? '').join('');

/** What the daemon wrote for `method`, the first time. */
function sent(peer: AcpReplayPeer, method: string): Record<string, unknown> {
  const found = peer.received.find((message) => message.method === method);
  assert.ok(found, `the daemon never sent \`${method}\``);
  return (found.params ?? {}) as Record<string, unknown>;
}

/**
 * The checks of an ACP provider: how it launches the agent, how the session opens and what it declares to the agent,
 * a turn, the permission round trip and the sign-in message. Run them on a provider bound with `bindDialect`.
 */
export function acpSessionChecks(provider: Backend, exp: AcpSessionExpectation, ctx: ConformanceContext): ConformanceCheck[] {
  const script = asSteps(exp.script);
  const checks: ConformanceCheck[] = [
    {
      name: 'launches the agent in ACP mode with nothing sensitive on the command line',
      async run() {
        const opts = spawnOptions(ctx, '', null);
        const spawn = await provider.buildSpawn(opts);
        assert.match(spawn.cmd, new RegExp(exp.cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the declared program');
        assert.deepEqual(spawn.args, [...exp.args], 'the arguments that put the program in ACP mode');
        assert.equal(spawn.initialStdin ?? null, null, 'the prompt travels through the session, never through the first write');
        const argv = spawn.args.join('\n');
        for (const secret of [opts.systemPrompt, opts.message]) assert.ok(!argv.includes(secret), 'the prompt is not on the command line');
        assert.ok(!argv.includes('timon-seal-'), 'no token reference on the command line');
      },
    },
    {
      name: 'opens its session on the recorded agent, declares Timon\'s MCP servers with a reference and never a token',
      async run() {
        const rig = open(provider, ctx, script, true);
        try {
          const info = await rig.driver.start();
          assert.equal(info.sessionId, exp.sessionId);
          const init = rig.events.find((event) => event.type === 'system');
          assert.ok(init, 'the session announces itself with a system init');
          assert.equal((init.payload as { session_id?: string }).session_id, exp.sessionId);
          const request = sent(rig.peer, 'session/new') as { cwd?: string; mcpServers?: Array<{ name: string; env?: Array<{ name: string; value: string }> }> };
          assert.equal(request.cwd, ctx.cwd, 'the session starts where the process does');
          assert.deepEqual((request.mcpServers ?? []).map((server) => server.name).filter((name) => exp.mcpServers.includes(name)), [...exp.mcpServers]);
          for (const server of request.mcpServers ?? []) {
            const token = server.env?.find((entry) => entry.name === 'TIMON_API_TOKEN')?.value;
            if (token !== undefined) assert.match(token, /^timon-seal-/, `${server.name}: the token travels as a reference the daemon swaps`);
          }
        } finally {
          rig.close();
        }
      },
    },
    {
      name: 'runs a recorded turn: the text streams, one result closes it',
      async run() {
        const rig = open(provider, ctx, script, true);
        try {
          await rig.driver.start();
          rig.events.length = 0;
          const outcome = await rig.driver.prompt(ctx.message ?? DEFAULT_MESSAGE);
          assert.equal(outcome.stopReason, exp.stopReason);
          assert.equal(said(rig.events), exp.says);
          const results = rig.events.filter((event) => event.type === 'result');
          assert.equal(results.length, 1, 'exactly one result per turn');
          assert.equal((results[0]!.payload as { is_error?: boolean }).is_error ?? false, false);
        } finally {
          rig.close();
        }
      },
    },
  ];

  if (exp.permission) {
    const permission = exp.permission;
    for (const allow of [true, false]) {
      checks.push({
        name: `a tool use that asks permission reaches the host as a neutral request; ${allow ? 'Allow selects the agent\'s allow-once option' : 'Deny selects its reject option'}`,
        async run() {
          const rig = open(provider, ctx, script, allow);
          try {
            await rig.driver.start();
            await rig.driver.prompt(ctx.message ?? DEFAULT_MESSAGE);
            assert.equal(rig.asked.length, 1, 'one question for the user (or the classifier)');
            const label = `${rig.asked[0]!.tool} ${rig.asked[0]!.title ?? ''}`;
            assert.ok(typeof permission.tool === 'string' ? label.includes(permission.tool) : permission.tool.test(label), `the request names the tool (got: ${label})`);
            const answer = rig.peer.answer(permission.requestId) as { outcome?: { outcome?: string; optionId?: string } } | undefined;
            assert.equal(answer?.outcome?.outcome, 'selected', 'the agent was answered, not left hanging');
            assert.equal(answer?.outcome?.optionId, allow ? permission.allowOptionId : permission.denyOptionId);
          } finally {
            rig.close();
          }
        },
      });
    }
  }

  for (const extension of exp.extensions ?? []) {
    const steps = extension.script ? asSteps(extension.script) : script;
    const request = steps.flatMap((step) => step.send ?? []).find((message) => message.id === extension.requestId);
    const method = request?.method ?? `request ${String(extension.requestId)}`;
    const play = async (ask: SessionHost['ask'], expected: unknown): Promise<void> => {
      assert.ok(request, `the script sends no request with id ${String(extension.requestId)}`);
      const rig = open(provider, ctx, steps, true, ask);
      try {
        await rig.driver.start();
        await rig.driver.prompt(ctx.message ?? DEFAULT_MESSAGE);
        const reply = rig.peer.received.find((message) => message.id === extension.requestId && message.method === undefined);
        assert.ok(reply, `the agent's \`${method}\` was never answered: it would wait for ever`);
        assert.equal(reply.error, undefined, `\`${method}\` was answered with an error: ${JSON.stringify(reply.error)}`);
        assert.deepEqual(reply.result, expected);
      } finally {
        rig.close();
      }
    };
    checks.push({
      name: `the agent's own \`${method}\` opens a card, and the agent gets the answer in its own shape`,
      async run() {
        const cards: SessionAskRequest[] = [];
        await play(async (card) => { cards.push(card); return extension.answer(card); }, extension.reply);
        assert.equal(cards.length, 1, 'one card for the person');
      },
    });
    if (extension.unanswered !== undefined) {
      checks.push({
        name: `with nobody to ask, the agent's own \`${method}\` is answered at once`,
        run: () => play(undefined, extension.unanswered),
      });
    }
  }

  if (exp.signIn) {
    const signIn = exp.signIn;
    checks.push({
      name: 'an agent that wants a sign-in fails the start with what to do, and lets go',
      async run() {
        const rig = open(provider, ctx, asSteps(signIn.script), true);
        try {
          await assert.rejects(() => rig.driver.start(), signIn.message);
        } finally {
          rig.close();
        }
      },
    });
  }

  return checks;
}
