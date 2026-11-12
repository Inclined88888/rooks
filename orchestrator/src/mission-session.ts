/**
 * What the runner does with the session of a mission, whatever the provider
 * speaks (cf. `backends/engine`): a protocol driver (`Backend.openSession`,
 * "Bidirectional session drivers" in `backends/types.ts`), a remote one, or the
 * `LineSessionDriver` that stands for a line-oriented CLI.
 *
 * The driver owns both pipes, so the runner's part shrinks to three things, all in
 * this file: order the turns (one prompt at a time, in the order they were
 * sent), answer the agent's permission requests through the same Allow/Deny
 * card as every other backend, and say what became of a session that could not
 * be kept. Everything else (persistence, SSE, spans, usage) stays in `agent.ts`
 * and receives the driver's events through `emit`, exactly as it receives the
 * other dialects' `parseLine` output.
 */

import { randomUUID } from 'node:crypto';
import { isLineSessionDriver } from './backends/engine/index.js';
import type {
  ApprovalScope, ImageAttachment, NormalizedEvent, PermissionDecision as SessionDecision, PermissionRequest, PermissionWait,
  SessionAskOutcome, SessionAskRequest, SessionDriver, SessionHost,
} from './backends/index.js';
import { askRequestProblem, askUserInput, readSessionAnswers } from './backends/session-questions.js';

export type MissionSessionDeps = {
  /** The driver's events, into the runner's pipeline. */
  emit(ev: NormalizedEvent): void;
  /** A prompt is about to go to the agent: the turn is active from now on. */
  onTurnStart(): void;
  /** The session cannot go on (handshake refused, session stuck, process gone).
   *  The message is safe to show. The runner ends the process. `reattach`: it
   *  was a session reopened after a daemon restart (`reattach`). */
  onFailed(message: string, cause?: 'reattach'): void;
  /** How the agent's tool uses are arbitrated (the Allow/Deny card). */
  requestPermission: SessionHost['requestPermission'];
};

export class MissionSession {
  private chain: Promise<void> = Promise.resolve();
  private dead = false;
  /** A reattached turn waits here for its `result` (cf. `reattach`). */
  private resultWaiter: (() => void) | null = null;
  private resultSeen = false;

  constructor(
    readonly driver: SessionDriver,
    private readonly deps: MissionSessionDeps,
  ) {}

  /** Handshake, then the first turn. Returns at once: the runner's spawn must
   *  not wait for an agent that may take seconds to start. */
  begin(text: string, images?: ImageAttachment[]): void {
    if (this.writesAtOnce) { this.promptNow(text, images); return; }
    this.enqueue(async () => {
      await this.driver.start();
    }, text, images);
  }

  /** A follow-up turn. Turns sent while one runs wait for it, in order — a
   *  driver refuses a second concurrent prompt, and the persistent line-oriented
   *  backends queue too. */
  send(text: string, images?: ImageAttachment[]): void {
    if (this.writesAtOnce) { this.promptNow(text, images); return; }
    this.enqueue(async () => undefined, text, images);
  }

  /** The daemon restarted under a live remote session: reopen it, and when a
   *  turn was running, hold every later turn until that one's `result` came
   *  back — a prompt sent meanwhile would reach an agent still busy with it.
   *  No prompt is replayed: the agent already has it. */
  reattach(followTurn: boolean): void {
    this.resultSeen = false;
    this.run(async () => {
      await this.driver.start();
      // The driver may replay a `result` the daemon missed while starting.
      if (!followTurn || this.dead || this.resultSeen) return;
      await new Promise<void>((resolve) => { this.resultWaiter = resolve; });
    }, 'reattach');
  }

  /** The runner saw a `result` go by. */
  observeResult(): void {
    this.resultSeen = true;
    const waiter = this.resultWaiter;
    this.resultWaiter = null;
    waiter?.();
  }

  /** The driver speaks a session protocol (the agent can stop a turn and keep
   *  the conversation), as opposed to the lines of a process whose turn only
   *  ends with the process. What the runner reads to choose between
   *  `session/cancel` and a signal; it asks the driver, never a backend name. */
  get speaksProtocol(): boolean {
    return !isLineSessionDriver(this.driver);
  }

  /** A line-oriented driver has no handshake to wait for and never holds a
   *  turn: it opens already attached, and a message is bytes on a pipe, written
   *  before the call returns. Chaining it behind microtasks would only let the
   *  agent's first words (or the turn's end) overtake the turn's start. */
  private get writesAtOnce(): boolean {
    return !this.speaksProtocol;
  }

  private promptNow(text: string, images?: ImageAttachment[]): void {
    if (this.dead) return;
    this.deps.onTurnStart();
    this.driver.prompt(text, images).catch((err: unknown) => {
      if (this.dead) return;
      this.dead = true;
      this.deps.onFailed(err instanceof Error ? err.message : 'the agent session failed');
    });
  }

  /** The driver can redirect a running turn (`SessionDriver.steer`). */
  get canSteer(): boolean {
    return typeof this.driver.steer === 'function';
  }

  /** Redirects the running turn. `false` = nothing to steer (or no way to). A
   *  driver that throws is a refusal, never an exception for the caller. */
  async steer(text: string): Promise<boolean> {
    if (this.dead || !this.driver.steer) return false;
    try {
      return await this.driver.steer(text);
    } catch {
      return false;
    }
  }

  /** Stops the running turn; it still ends with its own `result`. */
  async cancel(): Promise<void> {
    try {
      await this.driver.cancel();
    } catch {
      // A session already gone has nothing left to cancel.
    }
  }

  close(): void {
    this.dead = true;
    this.driver.close();
    this.observeResult();
  }

  private enqueue(before: () => Promise<void>, text: string, images?: ImageAttachment[]): void {
    this.run(async () => {
      await before();
      if (this.dead) return;
      this.deps.onTurnStart();
      await this.driver.prompt(text, images);
    });
  }

  private run(step: () => Promise<void>, cause?: 'reattach'): void {
    this.chain = this.chain.then(async () => {
      if (this.dead) return;
      try {
        await step();
      } catch (err) {
        if (this.dead) return;
        this.dead = true;
        const message = err instanceof Error ? err.message : 'the agent session failed';
        if (cause) this.deps.onFailed(`the remote session could not be resumed after the daemon restarted: ${message}`, cause);
        else this.deps.onFailed(message);
      }
    });
  }
}

/** The card + expiry machinery lives in `permissions.ts`, which imports the
 *  runner: loaded on demand, so this file (and the runner) never import it at
 *  module load. */
export type PermissionGate = (input: {
  mission_id: string;
  agent: string;
  tool_name: string;
  input: unknown;
  tool_use_id: string;
  scopes?: readonly ApprovalScope[];
  /** Cf. `RequestInput.onPaste` (`permissions.ts`). */
  onPaste?: (command: string) => void;
  /** Cf. `RequestInput.signal` and `retireAtOnce` (`permissions.ts`). */
  signal?: AbortSignal;
  retireAtOnce?: boolean;
}) => Promise<{ behavior: 'allow' | 'deny'; scope?: ApprovalScope; updatedInput?: unknown; message?: string }>;

/**
 * `SessionHost.requestPermission` for one mission.
 *
 * The same round trip the `rooks_ask` MCP makes for claude: a card in
 * the UI, and — on a mission nobody watches — the delay after which it refuses
 * with an instruction to look for a safe alternative or to block the task.
 * A card that cannot even be raised is a denial, never an allowance.
 *
 * A protocol answer carries no text: "Paste into a terminal" reaches the agent
 * as a bare rejection. `relayPaste` gets the command then, to tell the agent
 * who runs it — after its turn, never inside it (`relayPasteReply`).
 */
export function permissionHost(
  missionId: string,
  agentName: string,
  gate: PermissionGate,
  relayPaste?: (command: string) => void,
): SessionHost['requestPermission'] {
  return async (req: PermissionRequest, wait?: PermissionWait): Promise<SessionDecision> => {
    try {
      const decision = await gate({
        mission_id: missionId,
        agent: agentName,
        tool_name: req.tool,
        input: req.input ?? {},
        // The agent's own id ties the card to the tool call; a request that
        // carries none gets one, so two of them never collapse into one card.
        tool_use_id: req.toolCallId ?? randomUUID(),
        ...(req.scopes?.length ? { scopes: req.scopes } : {}),
        ...(relayPaste ? { onPaste: relayPaste } : {}),
        // A driver that stops waiting never asks for the same call again: no
        // reconnection to wait for, the card goes as soon as the agent drops it.
        ...(wait?.signal ? { signal: wait.signal, retireAtOnce: true } : {}),
      });
      const allow = decision.behavior === 'allow';
      // A scope is only ever honoured with an Allow, and only one the request
      // listed: the answer is validated against what was offered.
      const scope = allow && decision.scope && req.scopes?.includes(decision.scope) ? decision.scope : undefined;
      return scope ? { allow, scope } : { allow };
    } catch {
      return { allow: false };
    }
  };
}

/**
 * `SessionHost.ask` for one mission: the `question` card (`ask_user`), raised
 * through the same gate as a tool use, so every rule of that card holds — an
 * unattended mission is refused with the name of who to ask instead, a
 * developer account is never auto-answered (it is a form, not a tool use).
 */
export function questionHost(
  missionId: string,
  agentName: string,
  gate: PermissionGate,
): NonNullable<SessionHost['ask']> {
  return async (req: SessionAskRequest, wait?: PermissionWait): Promise<SessionAskOutcome> => {
    const defect = askRequestProblem(req);
    if (defect) return { answered: false, reason: `the question cannot be shown: ${defect}` };
    try {
      const decision = await gate({
        mission_id: missionId,
        agent: agentName,
        tool_name: 'ask_user',
        input: askUserInput(req),
        tool_use_id: req.id ?? randomUUID(),
        ...(wait?.signal ? { signal: wait.signal, retireAtOnce: true } : {}),
      });
      if (decision.behavior !== 'allow') {
        return { answered: false, reason: decision.message?.trim() || 'the question was closed without an answer' };
      }
      return { answered: true, answers: readSessionAnswers(req.questions, decision.updatedInput) };
    } catch {
      return { answered: false, reason: 'the question could not be asked' };
    }
  };
}
