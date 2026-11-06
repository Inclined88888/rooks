/**
 * The one Kanban write a mission may make without `kanban:write`: closing the
 * task it runs (TODO #752, #787). `timon task done` / `block` / `mark-as-done`
 * and the MCP `kanban_mark_as_done` go through it; refusing it would leave the
 * task of an owner without `kanban:write` hanging IN_PROGRESS.
 *
 * "Its task" is read from the token's own mission binding only. The
 * `X-TIMON-Mission` header and a body `mission_id` are what the caller says,
 * not what it is: trusting them would let any token close any mission's task.
 */
import type { Request } from 'express';
import { dbApi } from '../../db.js';

/** The task the caller's own mission runs, if its token is bound to one. */
export function ownMissionTaskId(req: Request): string | null {
  const auth = req.auth;
  if (!auth || auth.kind !== 'api-token' || !auth.missionId) return null;
  return dbApi.getTaskByMission(auth.missionId)?.id ?? null;
}

export function isOwnMissionTask(req: Request, taskId: string): boolean {
  return !!taskId && ownMissionTaskId(req) === taskId;
}
