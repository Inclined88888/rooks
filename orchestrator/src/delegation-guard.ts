/**
 * The HTTP side of `agent-orchestration.ts`: who is calling, and the refusal
 * that goes with it. One place, so `POST /api/missions`, `/api/missions/delegate`
 * and the Kanban routes cannot each grow their own reading of the rule.
 */
import type { Request } from 'express';
import { listAgents } from './agent.js';
import { explainRefusal, mayDelegate, resolveOrchestrates, type EffectiveOrchestrates } from './agent-orchestration.js';
import { dbApi } from './db.js';
import { mainAgentName } from './main-agent.js';
import { auditRequest } from './users/audit-actor.js';
import { isPersonAuth } from './users/identity.js';

/** Stands for a caller whose mission no longer exists: never in the roster,
 *  so it fails closed instead of passing for an operator. */
export const UNKNOWN_CALLER = '\u0000unknown-mission';

/**
 * The agent a request delegates AS, or `null` for a human or an operator
 * (a session, a terminal without a mission): no list applies to them.
 *
 * A mission-bound api-token is the identity the daemon issued: its mission row
 * says which agent is calling, and no header or `source_meta` can override it.
 * That is the credential every mission holds (`missionEnv`), and the `rooks`
 * CLI and MCP server refuse to fall back to the daemon-token inside a mission,
 * so "no mission header" is never an agent that forgot to say who it is.
 *
 * The daemon-token is the operator's credential and cannot prove who holds it.
 * A mission claim on it (`X-ROOKS-Mission`, a terminal `rooks spawn` from
 * inside a mission) can only RESTRICT that operator, never widen: the bearer
 * already has every right, so trusting the claim gives it nothing.
 */
export function delegatingAgent(req: Request, claimedMission?: string | null): string | null {
  const auth = req.auth;
  if (!auth || isPersonAuth(auth)) return null;
  const missionId = auth.kind === 'api-token'
    ? auth.missionId
    : req.header('X-ROOKS-Mission') ?? claimedMission;
  if (!missionId) return null;
  const mission = dbApi.getMission(missionId);
  return mission?.agent_name ?? (auth.kind === 'api-token' ? UNKNOWN_CALLER : null);
}

/** The reason to refuse a delegation to `target`, or `null` when it may go
 *  ahead. Every refusal is audited: an agent probing beyond its list is the
 *  signal an operator wants to see. */
export function delegationRefusal(req: Request, target: string, claimedMission?: string | null): string | null {
  const caller = delegatingAgent(req, claimedMission);
  if (caller === null) return null;
  const roster = listAgents();
  const main = mainAgentName();
  if (mayDelegate(caller, target, roster, main)) return null;
  const reason = caller === UNKNOWN_CALLER
    ? `this mission does not orchestrate "${target}"`
    : `agent "${caller}" does not orchestrate "${target}"${explainRefusal(caller, target, roster, main)}`;
  auditRequest(req, 'orchestration.denied', `${caller === UNKNOWN_CALLER ? 'unknown' : caller} → ${target}`);
  return reason;
}

/** Effective lists of every agent, from one roster read (list + detail routes). */
export function effectiveOrchestration(names?: readonly string[]): Map<string, EffectiveOrchestrates> {
  const roster = listAgents();
  const main = mainAgentName();
  const out = new Map<string, EffectiveOrchestrates>();
  for (const a of roster) {
    if (names && !names.includes(a.name)) continue;
    const effective = resolveOrchestrates(a.name, roster, main);
    if (effective) out.set(a.name, effective);
  }
  return out;
}
