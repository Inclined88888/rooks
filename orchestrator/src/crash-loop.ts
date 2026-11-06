/**
 * Who may send a task that keeps dying back into the queue (TIM-0065).
 *
 * The automatic requeues stop at `MAX_SYSTEM_REQUEUES`, then the task is
 * blocked and its pilot woken with "fix/re-queue". The loop that remained went
 * through that pilot: it set the task back to PENDING, the dispatcher replayed
 * it at once, the mission died the same way, and the pilot was woken again. The
 * only brake was an in-memory counter of the wake loop, lost at every restart
 * and reset by any death slower than ten minutes.
 *
 * The rule, read from the database so a restart cannot reset it:
 *   - a human (session, terminal without a mission) restarts the task with a
 *     fresh budget: that is the decision the escalation asked for;
 *   - an agent's requeue waits out the same backoff as an automatic one;
 *   - past the cap, an agent may only requeue a task it corrected (another
 *     agent, backend or model): replaying it unchanged gives the same death;
 *   - past `CRASH_LOOP_HARD_CEILING`, only a human may.
 */
import { CRASH_LOOP_HARD_CEILING, MAX_SYSTEM_REQUEUES, type TaskRow } from './db.js';
import { countsTowardCrashLoop, requeueBackoffMs, toInterruptionReason } from './interruption.js';

type TaskState = Pick<TaskRow, 'status' | 'interrupted_reason' | 'requeue_count'>;

/** The fields of a task update that change what the next attempt runs on. */
export type RequeueCorrection = {
  agent_name?: string | null;
  backend_override?: string | null;
  model_override?: string | null;
};

/** The task is blocked by a system death that counts toward a crash loop. */
export function diedOfSystemCause(task: Pick<TaskRow, 'status' | 'interrupted_reason'>): boolean {
  const reason = toInterruptionReason(task.interrupted_reason);
  return task.status === 'BLOCKED' && reason !== null && countsTowardCrashLoop(reason);
}

/**
 * The update changes the agent, the backend or the model of the task. Mirrors
 * what `updateTask` persists: an absent override is kept, `null` clears it, and
 * clearing an override the task does not carry changes nothing.
 */
export function isCorrection(
  task: Pick<TaskRow, 'agent_name' | 'backend_override' | 'model_override'>,
  body: RequeueCorrection,
): boolean {
  const changed = (key: 'backend_override' | 'model_override'): boolean =>
    body[key] !== undefined && body[key] !== (task[key] ?? null);
  return (typeof body.agent_name === 'string' && body.agent_name !== task.agent_name)
    || changed('backend_override')
    || changed('model_override');
}

/** Why an AGENT may not set this task back to PENDING, or `null` when it may. */
export function agentRequeueRefusal(task: TaskState, correction: boolean): string | null {
  if (!diedOfSystemCause(task)) return null;
  const deaths = task.requeue_count ?? 0;
  if (deaths >= CRASH_LOOP_HARD_CEILING) {
    return `crash loop: this task died ${deaths} times from a system cause (${task.interrupted_reason}). `
      + 'Only a human can restart it now: escalate with the reason, and do not recreate it as a new task.';
  }
  if (deaths >= MAX_SYSTEM_REQUEUES && !correction) {
    return `crash loop: this task died ${deaths} times from a system cause (${task.interrupted_reason}) `
      + 'and replaying it unchanged would die the same way. Change its agent, backend or model '
      + 'in the same update, or escalate to a human.';
  }
  return null;
}

/** How long an agent's requeue of this task waits before dispatch. */
export function agentRequeueDelayMs(task: TaskState): number {
  return diedOfSystemCause(task) ? requeueBackoffMs(Math.max(1, task.requeue_count ?? 0)) : 0;
}
