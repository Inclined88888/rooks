/**
 * `ctx.chat` (API 10): what a THIRD-PARTY plugin may put in a mission's
 * conversation besides documents — a media (`chat_show_media`) and a command
 * for the owner to decide on (`terminal_propose`).
 *
 * Same identity rules as `layout-facade.ts`: the account behind the REQUEST
 * (a job has none: `no_owner`), and a mission that is that account's own. The
 * media is shown to the owner in their own chat. The command is never run by
 * anyone but the owner: its card offers paste (typed WITHOUT Enter in their
 * own terminal) and dismiss only — `allow` asks an agent to run it, and no
 * agent raised it. The call never waits for the owner; the answer is read
 * back with `commandRequests.get`.
 *
 * The command text stays out of the audit trail, like the agent's: it may
 * quote a secret.
 */
import { dbApi, type CommandRequestStatus, type MissionRow, type UserRow } from '../db.js';
import { scopedDb } from '../users/scoped-db.js';
import {
  accountOf, ownMission, pluginAudit, PluginLayoutError, unwrapReply, type LayoutCallerScope,
} from './layout-facade.js';

import type { PluginCommandRequest, ScopedChat } from './contract/layout.js';
export type { ScopedChat } from './contract/layout.js';
export type {
  PluginMediaInput, PluginMediaShown, PluginCommandInput, PluginCommandReceipt, PluginCommandRequest,
} from './contract/layout.js';

export type ChatCallerScope = Pick<LayoutCallerScope, 'pluginId' | 'viewer' | 'ownerUserId'>;

function requestView(row: { id: string; mission_id: string; status: CommandRequestStatus; created_at: number; resolved_at: number | null }): PluginCommandRequest {
  return Object.freeze({
    id: row.id,
    missionId: row.mission_id,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  });
}

export function chatFor(scope: ChatCallerScope): ScopedChat {
  const { pluginId, viewer } = scope;
  const origin = { kind: 'plugin', id: pluginId } as const;
  const own = (missionId: unknown): { user: UserRow; mission: MissionRow } => {
    const user = accountOf(scope);
    return { user, mission: ownMission(scope, user, missionId) };
  };

  return {
    async showMedia(input) {
      if (typeof input !== 'object' || input === null) throw new PluginLayoutError('invalid', 'expected an object');
      const { user, mission } = own(input.missionId);
      const { showMissionMedia } = await import('../plugins-bundled/missions/routes.js');
      const body: Record<string, unknown> = { src: input.src };
      if (input.caption !== undefined) body.caption = input.caption;
      const out = unwrapReply<{ block?: { kind?: string; mime?: string; source?: string } }>(await showMissionMedia(mission, body));
      pluginAudit(pluginId, user)('chat.media', mission.id);
      return Object.freeze({ kind: out.block?.kind ?? '', mime: out.block?.mime ?? '', source: out.block?.source ?? '' });
    },
    async proposeCommand(input) {
      if (typeof input !== 'object' || input === null) throw new PluginLayoutError('invalid', 'expected an object');
      const { user, mission } = own(input.missionId);
      const { raiseCommandRequest } = await import('../plugins-bundled/terminal-web/proposals.js');
      const body: Record<string, unknown> = { command: input.command };
      if (input.note !== undefined) body.note = input.note;
      if (input.sessionId !== undefined) body.session_id = input.sessionId;
      const raised = raiseCommandRequest(mission.id, body, pluginAudit(pluginId, user), () => null, origin);
      if ('reply' in raised) {
        if (raised.reply.status === 403) {
          throw new PluginLayoutError('refused', (raised.reply.body as { message?: string }).message ?? 'the owner cannot open a web terminal');
        }
        unwrapReply(raised.reply);
      }
      // Never waited for: the owner's decision is read with `commandRequests.get`.
      return Object.freeze({ id: (raised as { id: string }).id, status: 'pending' as const, choices: Object.freeze([...(raised as { choices: string[] }).choices]) });
    },
    commandRequests: {
      async get(id) {
        if (typeof id !== 'string') return undefined;
        const row = dbApi.getCommandRequest(id.toLowerCase());
        if (!row || row.origin_kind !== 'plugin' || row.origin_id !== pluginId) return undefined;
        if (row.owner_user_id !== scope.ownerUserId || !scopedDb(viewer).getMission(row.mission_id)) return undefined;
        return requestView(row);
      },
    },
  };
}
