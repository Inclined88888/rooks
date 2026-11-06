/**
 * Guarded entry point of the inter-agent inbox.
 *
 * `dbApi.enqueueMessage` is the storage chokepoint, but it validates nothing:
 * a message addressed to an agent that does not exist is inserted and never
 * delivered, and a message whose sending mission is unknown fails on the
 * `from_mission` foreign key with a raw `SqliteError` — an exception that
 * crossed the HTTP route uncaught and killed the SENDING mission (observed on
 * 03/09/2026: an agent of a sandbox home writing to an agent name that only
 * exists in another home).
 *
 * Anything an agent can address must therefore be checked here first, and
 * reported as a typed error the caller can turn into a readable answer.
 */

import { existsSync } from 'node:fs';
import { agentDir } from './paths.js';
import { canonicalAgentName, loadConfig } from './agent-config.js';
import { dbApi, type AgentMessageRow, type MessageKind } from './db.js';
import { openRequestFor } from './agent-request-replies.js';

/** Recipient absent from this home. Carries the name so the caller can name
 *  it back to the agent that typed it. */
export class UnknownAgentError extends Error {
  constructor(public readonly agent: string) {
    super(`unknown agent: ${agent}`);
    this.name = 'UnknownAgentError';
  }
}

/** Sending mission absent from the database — what the `from_mission`
 *  foreign key rejected, said in words. */
export class UnknownMissionError extends Error {
  constructor(public readonly mission: string) {
    super(`unknown mission: ${mission}`);
    this.name = 'UnknownMissionError';
  }
}

/** Sender and recipient belong to two different teams. Carries both names so
 *  the caller can say who was refused to whom. */
export class CrossTeamError extends Error {
  constructor(public readonly fromAgent: string, public readonly toAgent: string) {
    super(`${fromAgent} and ${toAgent} are not in the same team`);
    this.name = 'CrossTeamError';
  }
}

export class InvalidReplyError extends Error {}

/**
 * The request a response answers, or `InvalidReplyError`: it must exist and
 * belong to the same account, have been addressed to the agent that answers
 * (`senderAgent`, who must also be the `fromAgent` written on the response),
 * and have been sent by the agent the response goes to.
 */
export function validReplyTarget(
  request: AgentMessageRow | undefined,
  who: { senderAgent: string; fromAgent: string; ownerUserId: string | null; toAgent: string },
): AgentMessageRow {
  if (!request || request.owner_user_id !== who.ownerUserId
      || request.to_agent !== who.senderAgent || who.fromAgent !== who.senderAgent
      || request.from_agent !== who.toAgent) {
    throw new InvalidReplyError('reply does not match an accessible request and its participants');
  }
  return request;
}

export type SendMessageInput = {
  id: string;
  fromMission: string;
  fromAgent: string;
  toAgent: string;
  toMission?: string | null;
  kind?: MessageKind;
  payload: string;
  inReplyTo?: string | null;
};

/**
 * Sends a message to an agent's inbox, refusing what could not be delivered.
 *
 * `enqueue` is injected so a caller can pass its user-scoped variant
 * (`scopedDb(viewer).enqueueMessage`) without this module knowing about
 * viewers.
 *
 * The recipient is stored under its canonical name: inbox reads match
 * `to_agent` exactly, so a message filed under a different case would sit
 * there forever.
 */
export function sendAgentMessage(
  input: SendMessageInput,
  enqueue: (m: SendMessageInput) => AgentMessageRow = dbApi.enqueueMessage,
): AgentMessageRow {
  const toAgent = canonicalAgentName(input.toAgent);
  if (!existsSync(agentDir(toAgent))) throw new UnknownAgentError(input.toAgent);
  const sender = dbApi.getMission(input.fromMission);
  if (!sender) throw new UnknownMissionError(input.fromMission);
  // The agent reported to its pilot ITSELF: its return is delivered, the system
  // owes nothing more. Without this, the end of the turn (or the death of the
  // process) would stack a second return behind the message the pilot has just
  // read. Only a message going from a mission UP to its own pilot counts — an
  // agent writing to a peer has reported nothing. Posted AFTER the enqueue: a
  // refused message has delivered no return.
  const reportsToPilot = !!sender.parent_agent
    && input.fromAgent === sender.agent_name
    && canonicalAgentName(sender.parent_agent) === toAgent
    && sender.agent_name !== sender.parent_agent;
  // Team cloisonnement — deliberately ASYMMETRIC: it only fires when the
  // SENDER has a team. An agent without one (every project agent, `_main`, the
  // `_main.<ws>` hubs) keeps its historical reach, including towards an agent
  // that has a team. Two exemptions keep a teamed agent from becoming
  // unreachable for the orchestration that already exists:
  //   - its own pilot (the mission's `parent_agent`), so a mission return and
  //     an answer to `_main` still go through;
  //   - its declared `reports_to`, same reason outside a mission lineage.
  // Talking to itself is never a cross-team send.
  //
  // The sender is read from the MISSION ROW, never from `input.fromAgent`:
  // that field comes from the request body / `X-TIMON-Agent` on the non-token
  // paths, so a teamed agent claiming to be `_main` would resolve to no team
  // and walk straight through the rule. The rest of this function already
  // distrusts it the same way (see the `reportsToPilot` comparison above).
  const senderConfig = loadConfig(sender.agent_name);
  const fromTeam = senderConfig.team ?? null;
  if (fromTeam) {
    const pilot = sender.parent_agent ? canonicalAgentName(sender.parent_agent) : null;
    const reportsTo = senderConfig.reports_to;
    const exempt = toAgent === canonicalAgentName(sender.agent_name)
      || (pilot !== null && toAgent === pilot)
      || (!!reportsTo && toAgent === canonicalAgentName(reportsTo));
    if (!exempt && (loadConfig(toAgent).team ?? null) !== fromTeam) {
      throw new CrossTeamError(sender.agent_name, input.toAgent);
    }
  }
  // A free-form message to the agent whose request this mission is handling is
  // its answer: correlated, it reaches the asking mission and stands in for
  // the automatic end-of-turn reply instead of preceding a duplicate of it.
  const message = !input.inReplyTo && !input.toMission && input.fromAgent === sender.agent_name
    && (input.kind === undefined || input.kind === 'msg' || input.kind === 'response')
    ? (() => {
      const request = openRequestFor(sender.id, toAgent, sender.owner_user_id);
      return request ? { ...input, kind: 'response' as const, inReplyTo: request.id } : input;
    })()
    : input;
  const sent = (() => {
    if (message.kind === 'response' && message.inReplyTo) {
      const request = validReplyTarget(dbApi.getMessage(message.inReplyTo), {
        senderAgent: sender.agent_name, fromAgent: message.fromAgent, ownerUserId: sender.owner_user_id, toAgent,
      });
      return enqueue({ ...message, toAgent, toMission: request.from_mission });
    }
    return enqueue({ ...message, toAgent });
  })();
  if (reportsToPilot) dbApi.markMissionReturnNotified(sender.id);
  return sent;
}
