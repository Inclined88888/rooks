/**
 * Origin of an inbox message, derived from what the daemon already stores.
 *
 * `agent_messages` has no "origin" column and must not grow one: every
 * writer is known (`enqueueMessage` is the single chokepoint), so the origin
 * is a pure function of the row plus the sender mission. The inbox UI badges
 * rely on this rather than guessing from the raw payload.
 *
 * Vectors observed in the code (2026-09-03):
 * - `POST /api/messages` (MCP `agent_send_message`, `rooks msg send`):
 *   kind msg/request/response, sender = a real agent → `agent`, unless the
 *   sender mission was itself spawned by a routine → `routine`.
 * - `notify.ts` `notifyUser()`: from `orchestrator`, payload.kind
 *   `system_alert` → `system_alert`.
 * - `wake.ts` recap: from `orchestrator-wake`, payload.kind `wake_recap`
 *   → `wake`.
 * - `wake.ts` task closure: payload.kind `task_closed` → `task_return`.
 * - `agent.ts` mission end: payload.kind `mission_complete` → `mission_return`.
 * - "TO DO" `project-todo` push: from `cockpit`, plain text → `cockpit`.
 */

export type MessageOrigin =
  | 'agent'
  | 'workflow'
  | 'routine'
  | 'cockpit'
  | 'wake'
  | 'system_alert'
  | 'task_return'
  | 'mission_return';

export type OriginInput = {
  from_agent: string;
  payload: string;
};

export type OriginSender = {
  source_channel: string | null;
  routine_id: string | null;
} | null | undefined;

const PAYLOAD_KIND_ORIGIN: Record<string, MessageOrigin> = {
  wake_recap: 'wake',
  system_alert: 'system_alert',
  task_closed: 'task_return',
  mission_complete: 'mission_return',
};

function payloadKind(payload: string): string | null {
  // Only JSON objects carry a `kind`; free text is what agents type to each other.
  if (!payload.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return null;
    const kind = (parsed as Record<string, unknown>).kind;
    return typeof kind === 'string' ? kind : null;
  } catch {
    return null;
  }
}

/** Derive the origin of a message from its row and (optionally) its sender mission. */
export function messageOrigin(msg: OriginInput, sender?: OriginSender): MessageOrigin {
  const kind = payloadKind(msg.payload);
  if (kind && PAYLOAD_KIND_ORIGIN[kind]) return PAYLOAD_KIND_ORIGIN[kind]!;
  if (msg.from_agent === 'orchestrator-wake') return 'wake';
  if (msg.from_agent === 'cockpit') return 'cockpit';
  if (msg.from_agent === 'orchestrator') return 'system_alert';
  if (sender && (sender.routine_id || sender.source_channel === 'routine')) return 'routine';
  return 'agent';
}
