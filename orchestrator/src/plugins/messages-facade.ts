/**
 * `ctx.messages`: the inter-agent inbox, for the agents a plugin created — what
 * `POST /api/messages`, `GET /api/messages` and the `agent_send_message`,
 * `agent_recv_messages`, `agent_pick_message` and `agent_reply` tools do for a
 * mission. A plugin bridging an outside system gives each of its profiles an
 * agent (`ctx.agents.create`), forwards what comes in as a message TO that
 * agent, and reads what other agents say to it with `recv`.
 *
 * Who speaks, and who is heard:
 *  - a message is written as one of the plugin's own agents (`as`), or as
 *    `plugin:<id>` — which cannot be answered, so it carries no request. A
 *    plugin never writes as an agent it did not create, a superadmin's request
 *    included: that would be forging a human's agent;
 *  - a job reaches only the agents it created, as recipients and as inboxes. A
 *    request may address any agent the account may talk to (the same
 *    `messages:send` rule as the route), but reads, picks and answers only the
 *    inbox of an agent THIS plugin created — a superadmin's request excepted —
 *    and only the messages that account owns;
 *  - messages written here are owned by the account of the request, or by
 *    `plugin:<id>` in a job.
 *
 * The sending mission the inbox's foreign key wants is the daemon's own
 * "system" mission (`notify.ts`). A reply to a message sent by a plugin is
 * addressed to that mission, which belongs to no agent: the wake loop leaves it
 * alone, and the plugin reads it with `recv`.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalAgentName, loadConfig, validName } from '../agent-config.js';
import {
  CrossTeamError, InvalidReplyError, sendAgentMessage, UnknownAgentError,
} from '../agent-messages.js';
import { dbApi, type AgentMessageRow } from '../db.js';
import { systemMissionId } from '../notify.js';
import { scopedDb } from '../users/scoped-db.js';
import type { DbViewer } from '../users/owned.js';
import { PLUGIN_OWNER_PREFIX } from '../users/api-tokens.js';
import { agentDir } from '../paths.js';
import { PluginAgentError, resolveOwnAgent } from './agents-facade.js';

import type { PluginMessage, PluginMessageErrorCode, ScopedMessages } from './contract/messages.js';
export type { ScopedMessages } from './contract/messages.js';
export type {
  PluginMessage, PluginMessageInput, PluginMessageRecvOptions, PluginMessageErrorCode,
} from './contract/messages.js';

export class PluginMessageError extends Error {
  constructor(readonly code: PluginMessageErrorCode, message: string) {
    super(message);
    this.name = 'PluginMessageError';
  }
}

export type MessageCallerScope = {
  pluginId: string;
  job: boolean;
  superadmin: boolean;
  /** The account of the request; `null` in a job. */
  viewer: DbViewer | null;
};

const MAX_PAYLOAD = 200_000;
const Payload = z.union([z.string().min(1), z.record(z.string(), z.unknown())])
  .transform((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
  .refine((text) => text.length <= MAX_PAYLOAD, `payload too large (max ${MAX_PAYLOAD} characters)`);
const SendSchema = z.object({
  to: z.string().min(1).max(100),
  payload: Payload,
  kind: z.enum(['msg', 'request']).optional(),
  as: z.string().min(1).max(100).optional(),
}).strict();
const RecvSchema = z.object({
  status: z.enum(['pending', 'picked', 'expired', 'held']).optional(),
  from: z.string().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();
const IdSchema = z.string().min(1).max(100);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    const issue = res.error.issues[0];
    throw new PluginMessageError('invalid', `${issue?.path.length ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'invalid input'}`);
  }
  return res.data;
}

/** The cross-team rule of the inbox, for a sender that is an agent of the plugin. */
function assertSameTeam(fromAgent: string, toAgent: string): void {
  const sender = loadConfig(fromAgent);
  const fromTeam = sender.team ?? null;
  if (!fromTeam) return;
  const target = canonicalAgentName(toAgent);
  const exempt = target === canonicalAgentName(fromAgent)
    || (!!sender.reports_to && target === canonicalAgentName(sender.reports_to));
  if (!exempt && (loadConfig(target).team ?? null) !== fromTeam) {
    throw new PluginMessageError('forbidden', `${fromAgent} and ${toAgent} are not in the same team`);
  }
}

const view = (row: AgentMessageRow): PluginMessage => ({
  id: row.id, from: row.from_agent, to: row.to_agent, kind: row.kind, payload: row.payload,
  inReplyTo: row.in_reply_to, createdAt: row.created_at, pickedAt: row.picked_at, status: row.status,
});

export function messagesFor(scope: MessageCallerScope): ScopedMessages {
  const db = scopedDb(scope.viewer);
  const owner = scope.job ? `${PLUGIN_OWNER_PREFIX}${scope.pluginId}` : scope.viewer?.id ?? null;
  const own = (agent: unknown, superadmin: boolean): string => {
    try {
      return resolveOwnAgent({ ...scope, superadmin }, agent).name;
    } catch (err) {
      if (err instanceof PluginAgentError) {
        throw new PluginMessageError(err.code === 'forbidden' ? 'forbidden' : 'not_found', err.message);
      }
      throw err;
    }
  };
  /** The message `id` when it sits in the inbox of an agent this plugin created. */
  const inboxMessage = (id: unknown): AgentMessageRow => {
    const row = db.getMessage(parse(IdSchema, id));
    if (!row) throw new PluginMessageError('not_found', `message not found: ${String(id)}`);
    own(row.to_agent, scope.superadmin);
    return row;
  };
  const deliver = (fn: () => AgentMessageRow): { id: string; createdAt: number } => {
    try {
      const row = fn();
      return { id: row.id, createdAt: row.created_at };
    } catch (err) {
      if (err instanceof UnknownAgentError) throw new PluginMessageError('not_found', err.message);
      if (err instanceof CrossTeamError) throw new PluginMessageError('forbidden', err.message);
      if (err instanceof InvalidReplyError) throw new PluginMessageError('invalid', err.message);
      throw err;
    }
  };
  const enqueue = (m: Parameters<typeof dbApi.enqueueMessage>[0]): AgentMessageRow =>
    dbApi.enqueueMessage({ ...m, ownerUserId: owner });

  return {
    async send(input) {
      const fields = parse(SendSchema, input);
      try { validName(fields.to); } catch (err) { throw new PluginMessageError('invalid', (err as Error).message); }
      // `to` obeys the reach of the caller: a job only talks to its own agents.
      const to = scope.job ? own(fields.to, false) : canonicalAgentName(fields.to);
      const fromAgent = fields.as ? own(fields.as, false) : `plugin:${scope.pluginId}`;
      if (fields.kind === 'request' && !fields.as) {
        throw new PluginMessageError('invalid', 'a request expects an answer: write it `as` one of your agents, which can receive it');
      }
      // `sendAgentMessage` judges the team of the mission's agent, the daemon's own
      // here: the real sender is the agent written as, which is judged instead.
      if (fields.as) assertSameTeam(fromAgent, to);
      return deliver(() => sendAgentMessage({
        id: randomUUID(),
        fromMission: systemMissionId(),
        fromAgent,
        toAgent: to,
        kind: fields.kind ?? 'msg',
        payload: fields.payload,
      }, enqueue));
    },

    async recv(agent, opts = {}) {
      const target = own(agent, scope.superadmin);
      const fields = parse(RecvSchema, opts);
      return db.listInbox(target, {
        status: fields.status ?? 'pending',
        fromAgent: fields.from,
        limit: fields.limit ?? 50,
      }).map(view);
    },

    async pick(id) {
      const row = inboxMessage(id);
      const picked = db.pickMessage(row.id);
      if (!picked) throw new PluginMessageError('not_found', `message not found or already picked: ${row.id}`);
      return view(picked);
    },

    async reply(id, payload) {
      const request = inboxMessage(id);
      const text = parse(Payload, payload);
      // Answers as the agent the message was addressed to — always a plugin's own.
      if (request.from_agent.startsWith('plugin:')) {
        throw new PluginMessageError('invalid', 'the sender of this message is a plugin, which cannot be answered');
      }
      return deliver(() => {
        if (!existsSync(agentDir(canonicalAgentName(request.from_agent)))) throw new UnknownAgentError(request.from_agent);
        return enqueue({
          id: randomUUID(),
          fromMission: systemMissionId(),
          fromAgent: request.to_agent,
          toAgent: canonicalAgentName(request.from_agent),
          toMission: request.from_mission,
          kind: 'response',
          payload: text,
          inReplyTo: request.id,
        });
      });
    },
  };
}
