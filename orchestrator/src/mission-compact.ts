/**
 * Compacting a mission (TODO #504): one operation, answered at once, followed
 * on the mission's stream.
 *
 * Two ways, chosen by the daemon and never by the client:
 *   - `native`: the backend compacts its own session (`SessionStrategy.compact`,
 *     `/compact` for Claude and Grok). The conversation goes on in the SAME
 *     mission and session. Only when the caller keeps the mission's backend and
 *     model: another LLM has no session to compact.
 *   - `fork`: a forced summary of the transcript, then a new mission seeded with
 *     it (`summarizeMission` + `forkMission`, the path the LLM dialog used to
 *     chain itself). Same model by default, or the one the caller picked.
 *
 * Why an operation and not one long request: a summary is a whole model turn,
 * minutes on a long thread. The request used to hang that long with nothing
 * on screen; now the client gets a 202 and the phases arrive as
 * `compact_progress` on the bus (hence on `/api/missions/:id/stream`). The
 * operation lives in memory only — a daemon restart kills the summariser and
 * the native turn with it — and `GET /api/missions/:id/compact` is how a client
 * that reloads learns what is under way. The OUTCOME is persisted, as a
 * `compact` event in the thread.
 *
 * A native compaction is refused while a turn runs (409) rather than queued:
 * queued, it would start minutes later with no one watching, and the user can
 * just as well press again once the turn is over.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getTurnState, respawnWithResume, sendToAgent } from './agent.js';
import { catalogBackend, defaultBackendName, nativeCompactCommand } from './backends/index.js';
import { bus, type BusEvent } from './bus.js';
import { dbApi } from './db.js';
import { settingNum } from './settings.js';
import { forkMission, missionLlmConfig, summarizeMission } from './summary.js';
import type { UserEventOrigin } from './user-origin.js';

export type CompactMode = 'native' | 'fork';
export type CompactPhase = Extract<BusEvent, { kind: 'compact_progress' }>['phase'];

export type CompactOperation = {
  readonly id: string;
  readonly missionId: string;
  readonly mode: CompactMode;
  phase: CompactPhase;
  /** The LLM the conversation goes on with. */
  readonly backend: string;
  readonly model: string | null;
  /** Native: the mission itself. Fork: the new mission, once spawned. */
  targetMissionId: string | null;
  error: string | null;
  readonly startedAt: number;
  updatedAt: number;
};

export const CompactBodySchema = z.object({
  backend: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  reasoning_effort: z.string().trim().min(1).max(40).nullable().optional(),
  /** First message of the conversation once compacted. */
  message: z.string().max(20_000).optional(),
}).strict();
export type CompactBody = z.infer<typeof CompactBodySchema>;

/** What the mission runs on now, as `spawnTurn` would launch it. */
export type MissionLlm = { agent: string; backend: string; model: string | null; reasoningEffort: string | null };

/** Outcome of handing the compaction command to the mission's agent. */
export type CommandOutcome = 'delivered' | 'turn_in_flight' | 'not_resumable';

export type CompactDeps = {
  currentLlm(missionId: string): MissionLlm;
  /** The message that makes `backend` compact its own session, or null. */
  nativeCommand(backend: string): string | null;
  turnActive(missionId: string): boolean;
  sendCommand(missionId: string, command: string): Promise<CommandOutcome>;
  /** Deliver the caller's message as an ordinary turn, after a native compaction. */
  sendMessage(missionId: string, text: string): Promise<boolean>;
  summarize(missionId: string): Promise<unknown>;
  fork(opts: {
    sourceMissionId: string; targetAgent: string; continuation?: string;
    backendOverride: string; modelOverride: string | null; reasoningEffort: string | null;
  }): Promise<{ missionId: string }>;
  /** Persist the outcome in the thread (`compact` event). */
  record(missionId: string, payload: Record<string, unknown>): void;
  /** Ceiling of a native compaction turn. */
  timeoutMs(): number;
};

export type StartOutcome =
  | { status: 202; body: { operation: CompactOperation } }
  | { status: 409; body: { error: string; code: 'compact_in_progress' | 'turn_in_flight'; operation?: CompactOperation } };

/** A finished operation stays readable this long, so a client that reloads
 *  right after still learns where the conversation went. */
const KEEP_FINISHED_MS = 15 * 60_000;

const operations = new Map<string, CompactOperation>();

function finished(op: CompactOperation): boolean {
  return op.phase === 'done' || op.phase === 'error';
}

/** The operation of this mission: the one under way, or the last one if it
 *  ended less than 15 minutes ago. */
export function compactOperation(missionId: string, now = Date.now()): CompactOperation | null {
  const op = operations.get(missionId);
  if (!op) return null;
  if (finished(op) && now - op.updatedAt > KEEP_FINISHED_MS) {
    operations.delete(missionId);
    return null;
  }
  return { ...op };
}

/** Tests only: forget every operation. */
export function resetCompactOperations(): void {
  operations.clear();
}

/** Native when the caller keeps the mission's LLM (or names none) and the
 *  backend declares it can; a fork everywhere else. */
export function planCompaction(
  current: MissionLlm,
  body: CompactBody,
  nativeCommand: (backend: string) => string | null,
): { mode: 'native'; command: string; backend: string; model: string | null }
  | { mode: 'fork'; backend: string; model: string | null; reasoningEffort: string | null } {
  const backend = body.backend ?? current.backend;
  const sameBackend = backend === current.backend;
  const model = body.model ?? (sameBackend ? current.model : null);
  const sameLlm = sameBackend && (body.model === undefined || body.model === current.model);
  const command = sameLlm ? nativeCommand(backend) : null;
  if (command) return { mode: 'native', command, backend, model: current.model };
  // An effort level belongs to the provider it was set for.
  const reasoningEffort = body.reasoning_effort !== undefined
    ? body.reasoning_effort
    : sameBackend ? current.reasoningEffort : null;
  return { mode: 'fork', backend, model, reasoningEffort };
}

function publish(op: CompactOperation): void {
  bus.publish({
    kind: 'compact_progress',
    missionId: op.missionId,
    operationId: op.id,
    mode: op.mode,
    phase: op.phase,
    targetMissionId: op.targetMissionId,
    error: op.error,
    at: op.updatedAt,
  });
}

function advance(op: CompactOperation, phase: CompactPhase, patch: Partial<Pick<CompactOperation, 'targetMissionId' | 'error'>> = {}): void {
  // An operation that already ended (timed out) is not revived by a late answer.
  if (finished(op)) return;
  op.phase = phase;
  if (patch.targetMissionId !== undefined) op.targetMissionId = patch.targetMissionId;
  if (patch.error !== undefined) op.error = patch.error;
  op.updatedAt = Date.now();
  publish(op);
}

function conclude(op: CompactOperation, deps: CompactDeps, outcome: { error: string } | { targetMissionId: string }, extra: Record<string, unknown> = {}): void {
  if (finished(op)) return;
  if ('error' in outcome) advance(op, 'error', { error: outcome.error });
  else advance(op, 'done', { targetMissionId: outcome.targetMissionId });
  try {
    deps.record(op.missionId, {
      type: 'compact',
      operation_id: op.id,
      mode: op.mode,
      outcome: op.phase,
      backend: op.backend,
      model: op.model,
      target_mission_id: op.targetMissionId,
      error: op.error,
      duration_ms: op.updatedAt - op.startedAt,
      ...extra,
    });
  } catch (err) {
    console.warn(`[compact] ${op.missionId.slice(0, 8)}: could not record the outcome: ${(err as Error).message}`);
  }
}

/**
 * Starts a compaction of `missionId` and answers at once. The caller has
 * already checked the request may touch this mission.
 */
export function startCompaction(missionId: string, body: CompactBody, deps: CompactDeps): StartOutcome {
  const current = operations.get(missionId);
  if (current && !finished(current)) {
    return { status: 409, body: { error: 'a compaction of this conversation is already under way', code: 'compact_in_progress', operation: { ...current } } };
  }
  const llm = deps.currentLlm(missionId);
  const plan = planCompaction(llm, body, deps.nativeCommand);
  if (plan.mode === 'native' && deps.turnActive(missionId)) {
    return { status: 409, body: { error: 'the agent is answering: compact once its turn is over', code: 'turn_in_flight' } };
  }
  const now = Date.now();
  const op: CompactOperation = {
    id: randomUUID(),
    missionId,
    mode: plan.mode,
    phase: 'started',
    backend: plan.backend,
    model: plan.model,
    targetMissionId: plan.mode === 'native' ? missionId : null,
    error: null,
    startedAt: now,
    updatedAt: now,
  };
  operations.set(missionId, op);
  publish(op);
  const run = plan.mode === 'native'
    ? runNative(op, plan.command, body.message, deps)
    : runFork(op, llm.agent, plan, body.message, deps);
  // `run` never rejects: every failure is turned into the `error` phase.
  void run;
  return { status: 202, body: { operation: { ...op } } };
}

async function runFork(
  op: CompactOperation,
  agent: string,
  plan: { backend: string; model: string | null; reasoningEffort: string | null },
  message: string | undefined,
  deps: CompactDeps,
): Promise<void> {
  try {
    advance(op, 'summarizing');
    // Forced: a summary cached before the last turns would fork a conversation
    // that forgot them. The fork then reuses this one (same last event).
    await deps.summarize(op.missionId);
    advance(op, 'forking');
    const out = await deps.fork({
      sourceMissionId: op.missionId,
      targetAgent: agent,
      ...(message?.trim() ? { continuation: message } : {}),
      backendOverride: plan.backend,
      modelOverride: plan.model,
      reasoningEffort: plan.reasoningEffort,
    });
    conclude(op, deps, { targetMissionId: out.missionId });
  } catch (err) {
    conclude(op, deps, { error: errorText(err, op.phase === 'forking' ? 'fork' : 'summary') });
  }
}

/** The compaction turn is over when the mission's turn is: it succeeded if
 *  the agent marked a compaction boundary on the way. */
async function runNative(op: CompactOperation, command: string, message: string | undefined, deps: CompactDeps): Promise<void> {
  // A holder, not a `let`: TypeScript does not see a callback assign it.
  const seen: { boundary: Record<string, unknown> | null } = { boundary: null };
  let settle!: (outcome: { error: string } | { ok: true }) => void;
  const ended = new Promise<{ error: string } | { ok: true }>((resolve) => { settle = resolve; });
  const channel = `mission:${op.missionId}`;
  const listener = (ev: BusEvent): void => {
    if (ev.kind === 'event' && ev.type === 'system') {
      const payload = ev.payload as { subtype?: unknown; compact_metadata?: unknown } | null;
      if (payload?.subtype === 'compact_boundary') {
        seen.boundary = payload.compact_metadata && typeof payload.compact_metadata === 'object'
          ? payload.compact_metadata as Record<string, unknown>
          : {};
      }
      return;
    }
    if (ev.kind === 'turn_complete') {
      if (seen.boundary) settle({ ok: true });
      else if (ev.outcome === 'failed') settle({ error: 'the compaction turn failed' });
      else if (ev.outcome === 'cancelled') settle({ error: 'the compaction turn was stopped by a steer' });
      else settle({ error: 'the agent ended its turn without compacting' });
      return;
    }
    if (ev.kind === 'mission_complete') {
      settle(seen.boundary ? { ok: true } : { error: 'the agent stopped before compacting' });
    }
  };
  // Subscribed BEFORE the command leaves: a short session compacts in seconds.
  bus.on(channel, listener);
  const limit = deps.timeoutMs();
  const timer = setTimeout(() => settle({ error: `no compaction after ${Math.round(limit / 1000)} s` }), limit);
  try {
    advance(op, 'compacting');
    const sent = await deps.sendCommand(op.missionId, command);
    if (sent === 'turn_in_flight') settle({ error: 'the agent is answering: compact once its turn is over' });
    else if (sent === 'not_resumable') settle({ error: 'this conversation has no session left to compact' });
    const outcome = await ended;
    if ('error' in outcome) {
      conclude(op, deps, outcome);
      return;
    }
    conclude(op, deps, { targetMissionId: op.missionId }, seen.boundary ? { compact_metadata: seen.boundary } : {});
    if (message?.trim()) {
      try {
        if (!(await deps.sendMessage(op.missionId, message))) {
          console.warn(`[compact] ${op.missionId.slice(0, 8)}: compacted, but the follow-up message found no session`);
        }
      } catch (err) {
        console.warn(`[compact] ${op.missionId.slice(0, 8)}: compacted, but the follow-up message failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    conclude(op, deps, { error: errorText(err, 'compaction') });
  } finally {
    clearTimeout(timer);
    bus.off(channel, listener);
  }
}

function errorText(err: unknown, step: string): string {
  const text = err instanceof Error ? err.message : String(err);
  return `${step}: ${text || 'unknown error'}`;
}

/** The command is the daemon's, not the human's: the thread shows who sent it. */
const COMMAND_ORIGIN: UserEventOrigin = { kind: 'system', from: 'orchestrator' };

/** A one-turn backend reports the end of its turn (`result`) before its
 *  process exits, and refuses a new turn until it has: the follow-up waits
 *  for the exit, a few seconds at most. */
const FOLLOW_UP_TRIES = 20;
const FOLLOW_UP_DELAY_MS = 500;

export function defaultCompactDeps(): CompactDeps {
  return {
    currentLlm(missionId) {
      const mission = dbApi.getMission(missionId);
      if (!mission) throw new Error(`mission ${missionId} not found`);
      const cfg = missionLlmConfig(mission);
      const backend = cfg.backend ?? defaultBackendName();
      return {
        agent: mission.agent_name,
        backend,
        model: cfg.model ?? catalogBackend(backend)?.defaultModel ?? null,
        reasoningEffort: cfg.reasoningEffort ?? null,
      };
    },
    nativeCommand: nativeCompactCommand,
    turnActive: (missionId) => getTurnState(missionId)?.turnActive === true,
    async sendCommand(missionId, command) {
      const turn = { agentCommand: true };
      const sent = await sendToAgent(missionId, command, undefined, COMMAND_ORIGIN, null, undefined, turn);
      if (sent !== 'no_live_process') return sent;
      // A persistent CLI reaped while idle: its session is resumed with the command.
      return await respawnWithResume(missionId, command, undefined, COMMAND_ORIGIN, null, undefined, turn)
        ? 'delivered'
        : 'not_resumable';
    },
    async sendMessage(missionId, text) {
      for (let i = 0; i < FOLLOW_UP_TRIES; i++) {
        const sent = await sendToAgent(missionId, text);
        if (sent === 'delivered') return true;
        if (sent === 'no_live_process') return respawnWithResume(missionId, text);
        await new Promise((resolve) => setTimeout(resolve, FOLLOW_UP_DELAY_MS));
      }
      return false;
    },
    summarize: (missionId) => summarizeMission(missionId, { force: true }),
    fork: (opts) => forkMission(opts),
    record(missionId, payload) {
      const row = dbApi.insertEvent(missionId, 'compact', payload);
      bus.publish({ kind: 'event', missionId, type: 'compact', timestamp: row.timestamp, payload });
    },
    timeoutMs: () => settingNum('ROOKS_SUMMARY_TIMEOUT_MS'),
  };
}
