/**
 * Who is asking the broker — resolved from the mission row, not from a header.
 *
 * `X-TIMON-Agent` is set by the MCP client out of its own environment, so an
 * agent can put anything in it. `X-TIMON-Mission` is equally forgeable, but the
 * mission id is the key of a row the daemon wrote itself: the agent name and
 * the project come from THAT row, never from the request.
 *
 * This does not defend against a hostile agent — it can read a sibling mission
 * id out of the API and claim it. It defends against the accident, which is the
 * threat model the vault was built for (SECRETS-VAULT.md §2): a mission
 * misreporting its own identity, an agent name drifting after a rename, an env
 * variable inherited from a parent mission.
 */
import type { Request } from 'express';
import { dbApi } from '../../db.js';
import { loadConfig } from '../../agent-config.js';
import { taskProjectSlug } from '../../task-project.js';
import type { BrokerCaller } from '../../secrets/broker.js';

export function callerFromRequest(req: Request): BrokerCaller {
  // A mission-bound api-token (the broker is reached through `timon_http_call`
  // under a delegate token) carries its mission id in the token itself, written
  // by the daemon. The `X-TIMON-Mission` header the MCP client also sends is
  // spoofable, so the token binding wins; the header stays as the fallback for
  // the daemon-token path (`timon git-credential`) where no mission is bound.
  const tokenMission = req.auth?.kind === 'api-token' ? req.auth.missionId ?? null : null;
  const missionId = tokenMission ?? ((req.header('X-TIMON-Mission') ?? '').trim() || null);
  const mission = missionId ? dbApi.getMission(missionId) : undefined;
  if (!mission) {
    // No mission behind the call (a plugin, a curl, a mission already gone):
    // it carries no identity, so it gets no grant beyond `global`. The header
    // is deliberately NOT used as a fallback agent name — that would make the
    // scoping trivially forgeable.
    return { missionId, agent: null, project: null };
  }
  const task = mission.task_id ? dbApi.getTask(mission.task_id) : undefined;
  let project: string | null = null;
  try {
    const cfg = loadConfig(mission.agent_name);
    project = taskProjectSlug({ project: task?.project ?? null }, cfg);
  } catch {
    // Agent config unreadable (deleted agent): the project simply stays unknown,
    // which narrows the grants rather than widening them.
    project = task?.project ?? null;
  }
  return { missionId: mission.id, agent: mission.agent_name, project };
}
