/**
 * `ctx.agents.export`: an agent's portable definition, so a plugin can carry
 * it to another Rooks (agent import, volet 9 — SUG-0084).
 *
 * `ctx.agents.list` gives an identity only and `ctx.agents.docs` reaches the
 * plugin's own agents: both on purpose, an agent's instructions being what
 * it does. An export needs the whole of ANY agent the account may read, so it
 * is its own sensitive permission (`agents:export`), shown apart at install,
 * and it only ever acts for a signed-in account: `context.ts` refuses a job
 * and an account without `agents:read` / `agents:manage` before this module
 * is reached. In the core an agent has no owner account; what is bounded by
 * the account is its team and its routines, and so they are here.
 *
 * What is read is what recreates the agent, nothing a machine or an owner
 * holds: no secret, trigger secret, token, log, transcript, memory file,
 * session, tool permission or browser profile.
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { canonicalAgentName, loadConfig } from '../agent-config.js';
import { dbApi } from '../db.js';
import { mainAgentName } from '../main-agent.js';
import { agentDir } from '../paths.js';
import { ownAgentSkills } from '../skill-attachments.js';
import { listTriggerRows } from '../triggers/store.js';
import { AGENT_ICON_URL_PREFIX, readAgentIcon, readProjectIcon, type ServedFile } from '../uploads.js';
import { addressableAgentName, PluginAgentError, type AgentCallerScope } from './agents-facade.js';

import type { PluginAgentExport, PluginAgentExportRoutine } from './contract/agents.js';
export type { PluginAgentExport, PluginAgentExportRoutine } from './contract/agents.js';

export type ScopedAgentExport = {
  export(name: string): Promise<PluginAgentExport>;
};

const PROJECT_ICON_URL_PREFIX = '/api/uploads/projects/';
const SYSTEM_PROMPT_DOC = 'system-prompt.md';
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const);
type AvatarMime = NonNullable<PluginAgentExport['avatar']>['mime'];

const ScheduleConfig = z.object({ cron: z.string().min(1), tz: z.string().optional() });
const TaskAction = z.object({ type: z.literal('task'), agent: z.string(), prompt: z.string() });

/** The picture this daemon serves for the agent; an address it does not store is not read. */
function avatarOf(iconUrl: string | undefined): PluginAgentExport['avatar'] {
  if (!iconUrl) return null;
  let file: ServedFile;
  try {
    if (iconUrl.startsWith(AGENT_ICON_URL_PREFIX)) file = readAgentIcon(iconUrl.slice(AGENT_ICON_URL_PREFIX.length));
    else if (iconUrl.startsWith(PROJECT_ICON_URL_PREFIX)) file = readProjectIcon(iconUrl.slice(PROJECT_ICON_URL_PREFIX.length));
    else return null;
  } catch {
    // Removed from disk, or a name the reader refuses: the agent goes without.
    return null;
  }
  const mime = file.contentType.split(';')[0]!.trim().toLowerCase();
  if (!(AVATAR_TYPES as Set<string>).has(mime)) return null;
  return { mime: mime as AvatarMime, data: file.bytes.toString('base64') };
}

/** Its routines: `schedule` triggers whose first action is a task for this agent, within the account's view. */
function routinesOf(agent: string, scope: AgentCallerScope): PluginAgentExportRoutine[] {
  // As `GET /api/triggers`: a superadmin sees every row, an account its own.
  const viewer = scope.viewer ?? null;
  if (!viewer) return [];
  const rows = listTriggerRows({ source: 'schedule', ...(scope.superadmin ? {} : { ownerId: viewer.id }) });
  const out: PluginAgentExportRoutine[] = [];
  for (const row of rows) {
    let config: unknown;
    let actions: unknown;
    try {
      config = JSON.parse(row.config);
      actions = JSON.parse(row.actions);
    } catch {
      continue;
    }
    const schedule = ScheduleConfig.safeParse(config);
    const first = TaskAction.safeParse(Array.isArray(actions) ? actions[0] : undefined);
    if (!schedule.success || !first.success) continue;
    if (canonicalAgentName(first.data.agent).toLowerCase() !== agent.toLowerCase()) continue;
    out.push({
      name: row.name,
      cron: schedule.data.cron,
      tz: schedule.data.tz ?? null,
      enabled: row.enabled === 1,
      prompt: first.data.prompt,
    });
  }
  return out;
}

export function agentExportFor(scope: AgentCallerScope): ScopedAgentExport {
  return {
    async export(name) {
      const target = addressableAgentName(name);
      const config = target && existsSync(agentDir(target)) ? loadConfig(target) : null;
      if (!target || !config || config.ephemeral === true) {
        throw new PluginAgentError('not_found', `agent not found: ${String(name)}`);
      }
      const { listDocs, readDoc } = await import('../agent.js');
      const docs: PluginAgentExport['docs'] = [];
      for (const doc of listDocs(target)) {
        if (doc.name === SYSTEM_PROMPT_DOC) continue;
        const content = readDoc(target, doc.name);
        if (content !== null) docs.push({ name: doc.name, content });
      }
      const team = config.team ? dbApi.getTeam(config.team, scope.viewer ?? null) : undefined;
      return {
        name: target,
        main: mainAgentName() === target,
        role: config.role ?? null,
        backend: config.backend ?? null,
        model: config.model ?? null,
        project: config.project ?? null,
        cwd: config.cwd ?? null,
        memoryScope: config.memory_scope ?? null,
        systemPrompt: readDoc(target, SYSTEM_PROMPT_DOC) ?? '',
        directives: config.directives ?? null,
        docs,
        skills: ownAgentSkills(target),
        mcpServers: [...(config.mcp_servers ?? [])],
        team: team ? { id: team.id, name: team.name, color: team.color, createdAt: team.created_at } : null,
        avatar: avatarOf(config.icon_url),
        routines: routinesOf(target, scope),
      };
    },
  };
}
