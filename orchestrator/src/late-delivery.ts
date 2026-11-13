/**
 * Answers that reach an agent after its tool call returned: a decision taken
 * on a card (a command request, a layout proposal) once the agent was told it
 * would come back as a message. Extracted verbatim from
 * `plugins-bundled/terminal-web/command-requests.ts` so every card shares one
 * delivery path.
 */
import { getTurnState, sendToAgent, type SendOutcome } from './agent.js';
import { bus, type BusEvent } from './bus.js';
import { dbApi } from './db.js';

/**
 * Whether a message sent now would reach an agent that can still act on it:
 * the mission runs, and its task — if any — is not closed. A coder that closed
 * its task is done, even while its idle process waits to be reaped; waking it
 * to say "the user pasted it" is worth nothing.
 */
export function agentStillListening(missionId: string): boolean {
  const mission = dbApi.getMission(missionId);
  if (mission?.status !== 'running') return false;
  const task = mission.task_id ? dbApi.getTask(mission.task_id) : undefined;
  return !task || (task.status !== 'DONE' && task.status !== 'BLOCKED');
}

/** How a late answer reaches the agent; tests stand in for a live mission. */
export type LateDelivery = {
  turnActive: (missionId: string) => boolean;
  send: (missionId: string, text: string) => Promise<SendOutcome>;
};

export const LIVE_DELIVERY: LateDelivery = {
  turnActive: (missionId) => getTurnState(missionId)?.turnActive ?? false,
  send: (missionId, text) =>
    sendToAgent(missionId, text, undefined, { kind: 'system', from: 'orchestrator', mission_id: missionId }),
};

/** Late answers held until the agent's current turn ends. */
const QUEUED = new Map<string, { texts: string[]; via: LateDelivery }>();
let listening = false;

function listenForTurnEnds(): void {
  if (listening) return;
  listening = true;
  bus.on('event', (ev: BusEvent) => {
    if (ev.kind === 'mission_complete') { QUEUED.delete(ev.missionId); return; }
    // A steered turn follows at once: the held answers wait for its end.
    if (ev.kind !== 'turn_complete' || ev.outcome === 'cancelled') return;
    const held = QUEUED.get(ev.missionId);
    if (!held) return;
    QUEUED.delete(ev.missionId);
    // After the emitter has finished its own bookkeeping of the turn's end.
    setImmediate(() => deliverLate(ev.missionId, held.texts.join('\n'), held.via));
  });
}

/**
 * Hands a late answer to the agent between two turns — never in the middle of
 * one, which would break its stream — and never to a mission that is over:
 * waking a finished task to say "the user pasted it" is worth nothing.
 */
export function deliverLate(missionId: string, text: string, via: LateDelivery = LIVE_DELIVERY): void {
  if (!agentStillListening(missionId)) return;
  const hold = (): void => {
    QUEUED.set(missionId, { texts: [...(QUEUED.get(missionId)?.texts ?? []), text], via });
    listenForTurnEnds();
  };
  if (via.turnActive(missionId)) { hold(); return; }
  via.send(missionId, text)
    .then((outcome) => { if (outcome === 'turn_in_flight') hold(); })
    .catch((err: unknown) => {
      console.warn(`[command-requests] late answer to ${missionId.slice(0, 8)} not delivered: ${(err as Error).message}`);
    });
}
