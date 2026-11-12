/**
 * Escalation to the user from the orchestrator (outside a living mission).
 *
 * `ask_user` (permissions.ts) requires a living mission + a tool_use_id, so it is
 * unusable from a post-mortem handler (dispatcher, recovery, verification
 * cap). The only channel that survives without an active mission = an `agent_message` of kind
 * `notification` addressed to the manager agent (ROOKS.main / _main), surfaced in the
 * `/messages` page of the UI.
 *
 * Schema constraint: `agent_messages.from_mission` is NOT NULL + FK to
 * `missions(id)`. A system notification has no real source mission → we
 * materialise a singleton "system" mission (finished, invisible to the spinners)
 * whose id serves as from_mission for every escalation without a mission of its own.
 */
import { randomUUID } from 'node:crypto';
import { dbApi } from './db.js';
import { mainAgentNameOrSeed } from './main-agent.js';

const SYSTEM_MISSION_ID = '00000000-0000-4000-8000-0000000000aa';
let systemMissionReady = false;

const managerAgent = mainAgentNameOrSeed;

function ensureSystemMission(): string {
  if (!systemMissionReady) {
    if (!dbApi.getMission(SYSTEM_MISSION_ID)) {
      dbApi.createMission(SYSTEM_MISSION_ID, managerAgent(), '[system] notifications orchestrateur', {
        channel: 'system',
      });
      dbApi.finishMission(SYSTEM_MISSION_ID, 'completed', 0);
    }
    systemMissionReady = true;
  }
  return SYSTEM_MISSION_ID;
}

/** "System" mission used as the source of the messages emitted by the orchestrator
 *  itself (not by an agent). Created on the fly at first use. */
export function systemMissionId(): string {
  return ensureSystemMission();
}

/**
 * Sends a notification visible to the user in `/messages`. `taskId` links the
 * notification to the task concerned; `fromMission`, if given and valid, serves as
 * source (otherwise the system mission). Any error is swallowed — an escalation
 * that fails must never crash the calling handler.
 */
export function notifyUser(
  title: string,
  body: string,
  opts: {
    taskId?: string;
    fromMission?: string | null;
    type?: 'report' | 'alert' | 'action_required';
    /** The agent concerned, when there is one (a series' pilot); the manager agent otherwise. */
    toAgent?: string | null;
  } = {},
): void {
  try {
    const to = opts.toAgent || managerAgent();
    const fromMission =
      opts.fromMission && dbApi.getMission(opts.fromMission)
        ? opts.fromMission
        : ensureSystemMission();
    dbApi.enqueueMessage({
      id: randomUUID(),
      fromMission,
      fromAgent: 'orchestrator',
      toAgent: to,
      kind: 'notification',
      payload: JSON.stringify({ kind: opts.type ?? 'alert', title, body, task_id: opts.taskId ?? null }),
    });
    console.warn(`[notify] → ${to}: ${title}`);
  } catch (err) {
    console.error(`[notify] failed: ${(err as Error).message}`);
  }
}
