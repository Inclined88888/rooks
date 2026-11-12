import { db, dbApi, type AgentMessageRow, type EventRow } from './db.js';
import { transientFailureReply, type TransientFailureFields } from './turn-retry.js';

type Delivery = { request_id: string; mission_id: string; event_id: number };

/** Reuse an owned conversation between requests instead of consuming an idle slot per turn. */
export function latestRequestMission(agent: string, owner: string | null): string | null {
  const row = db.prepare(`SELECT m.id FROM agent_request_deliveries d JOIN missions m ON m.id = d.mission_id
    WHERE m.agent_name = ? AND m.owner_user_id IS ? AND m.status = 'running'
    ORDER BY d.event_id DESC LIMIT 1`).get(agent, owner) as { id: string } | undefined;
  return row?.id ?? null;
}

/** One request per turn: a free-form answer cannot safely be split by sender. */
export function requestDeliveryBatch(messages: AgentMessageRow[]): AgentMessageRow[] {
  const request = messages.filter((m) => m.kind === 'request').sort((a, b) => a.created_at - b.created_at)[0];
  if (request) return [request];
  const first = messages[0];
  return first ? messages.filter((m) => m.owner_user_id === first.owner_user_id) : [];
}

export function recordRequestDelivery(missionId: string, eventId: number, ids: readonly string[]): void {
  const mission = dbApi.getMission(missionId);
  if (!mission) return;
  for (const id of ids) {
    const request = dbApi.getMessage(id);
    if (!request || request.kind !== 'request' || request.to_agent !== mission.agent_name
        || request.owner_user_id !== mission.owner_user_id
        || (request.to_mission && request.to_mission !== missionId)) continue;
    db.prepare(`INSERT OR IGNORE INTO agent_request_deliveries (request_id, mission_id, event_id)
      VALUES (?, ?, ?)`).run(id, missionId, eventId);
  }
}

/**
 * The single open request `missionId` owes `toAgent`. Two or more open
 * requests from the same agent make a free-form message ambiguous: it is then
 * left uncorrelated rather than attached to the wrong question.
 */
export function openRequestFor(missionId: string, toAgent: string, owner: string | null): AgentMessageRow | null {
  const rows = db.prepare(`SELECT m.* FROM agent_request_deliveries d JOIN agent_messages m ON m.id = d.request_id
    WHERE d.mission_id = ? AND d.settled_at IS NULL AND m.kind = 'request'
      AND m.from_agent = ? AND m.owner_user_id IS ? LIMIT 2`).all(missionId, toAgent, owner) as AgentMessageRow[];
  return rows.length === 1 ? rows[0]! : null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function payload(row: EventRow): Record<string, unknown> {
  try { return object(JSON.parse(row.payload)); } catch { return {}; }
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value.map(object).filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string).join('\n').trim();
}

function transientFailure(p: Record<string, unknown>): TransientFailureFields['transient_failure'] | null {
  const f = object(p.transient_failure);
  return typeof f.cause === 'string' && typeof f.provider_retries === 'number' && typeof f.nova_retries === 'number'
    ? f as TransientFailureFields['transient_failure'] : null;
}

/** Only committed root-agent output; tools, reasoning and child streams stay private. */
function turnReply(events: EventRow[], terminal?: string): string | null {
  let lastText = '';
  // The last transient failure Rooks decided to replay (TODO #459): the turn
  // goes on, and what it ends on is the answer.
  let replayed: Record<string, unknown> | null = null;
  // A steer stopped the turn (TODO #568): its instruction is the next input,
  // and the answer is what the steered turn ends on, not a new input's verdict.
  let steerInput = false;
  for (const row of events) {
    const p = payload(row);
    if (p.parent_tool_use_id) continue;
    if (row.type === 'turn_interrupted' && p.reason === 'steered') { steerInput = true; continue; }
    // The replay never ran: the turn ended on the failure it was replaying.
    if (row.type === 'turn_retry_abandoned') return transientFailureReply(replayed && transientFailure(replayed));
    if (row.type === 'assistant') {
      const message = object(p.message);
      const text = textContent(message.content);
      if (text && p.phase !== 'commentary' && message.phase !== 'commentary') lastText = text;
    }
    if (row.type === 'result') {
      if (p.nova_retry !== undefined && p.nova_retry !== null) { replayed = p; continue; }
      if (p.nova_steered === true) continue;
      if (p.is_error === true || (typeof p.subtype === 'string' && p.subtype.startsWith('error'))) {
        const transient = transientFailure(p);
        return transient ? transientFailureReply(transient) : 'The recipient could not complete this request (turn failed).';
      }
      return textContent(p.result) || lastText || 'The recipient finished the turn without a text response.';
    }
    // A later human/system input must never supply the answer to an earlier request.
    // Rooks's replay of the same turn is not a new input.
    if (row.type === 'user' && object(p.origin).turn_retry !== undefined) continue;
    const content = object(p.message).content;
    if (row.type === 'user' && (typeof content === 'string'
        || (Array.isArray(content) && content.some((b) => ['text', 'image'].includes(String(object(b).type)))))) {
      if (steerInput) { steerInput = false; continue; }
      return 'The request was interrupted by a new input before a response was completed.';
    }
  }
  if (!terminal) return null;
  if (terminal === 'completed') return lastText || 'The recipient finished the turn without a text response.';
  // The mission ended while its turn waited for a replay: that failure is the answer.
  if (replayed) return transientFailureReply(transientFailure(replayed));
  return `The recipient could not complete this request (mission ${terminal}).`;
}

/** Durable outbox: replay after a restart or duplicate turn_complete is harmless. */
export function completeRequestReplies(missionId: string, terminal?: string): void {
  const deliveries = db.prepare(`SELECT request_id, mission_id, event_id FROM agent_request_deliveries
    WHERE mission_id = ? AND settled_at IS NULL`).all(missionId) as Delivery[];
  if (!deliveries.length) return;
  const mission = dbApi.getMission(missionId);
  if (!mission) return;
  const events = dbApi.listEvents(missionId);
  for (const delivery of deliveries) {
    const request = dbApi.getMessage(delivery.request_id);
    if (!request || request.owner_user_id !== mission.owner_user_id || request.to_agent !== mission.agent_name) continue;
    const sender = dbApi.getMission(request.from_mission);
    if (!sender || sender.owner_user_id !== request.owner_user_id || sender.agent_name !== request.from_agent) continue;
    const body = turnReply(events.filter((e) => e.id > delivery.event_id), terminal);
    if (body === null) continue;
    db.transaction(() => {
      // Only a response correlated to THIS request already woke the requester
      // for it (`callsForTurn`, wake.ts). A free `msg` or an uncorrelated
      // `response` stays in its inbox without a turn — e.g. sent while two
      // requests from it were open, so correlation was ambiguous — and must
      // not stand in for the answer the requester is waiting on.
      const existing = db.prepare(`SELECT id FROM agent_messages WHERE from_agent = ? AND to_agent = ?
        AND owner_user_id IS ? AND in_reply_to = ? AND kind = 'response' LIMIT 1`)
        .get(mission.agent_name, request.from_agent, request.owner_user_id, request.id);
      if (!existing) {
        dbApi.enqueueMessage({
          id: `request-reply:${request.id}`, fromMission: missionId, fromAgent: mission.agent_name,
          toAgent: request.from_agent, toMission: request.from_mission, kind: 'response',
          inReplyTo: request.id, payload: body, ownerUserId: request.owner_user_id, traceId: request.trace_id,
        });
      }
      db.prepare('UPDATE agent_request_deliveries SET settled_at = ? WHERE request_id = ?')
        .run(Date.now(), request.id);
    })();
  }
}

export function reconcileRequestReplies(): void {
  const rows = db.prepare('SELECT DISTINCT mission_id FROM agent_request_deliveries WHERE settled_at IS NULL')
    .all() as { mission_id: string }[];
  for (const { mission_id: id } of rows) {
    const mission = dbApi.getMission(id);
    completeRequestReplies(id, mission && mission.status !== 'running' ? mission.status : undefined);
  }
}
