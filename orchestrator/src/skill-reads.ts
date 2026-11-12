/**
 * Journal of the skills missions read.
 *
 * A catalogue skill (skill-attachments.ts, mode `include`) costs one line in
 * the prompt; the agent is expected to read its body when a task matches. A
 * skill no mission ever reads is a description that does not make the agent
 * reach for it: the widget "Agent injections" shows the count so it can be
 * rewritten.
 *
 * Two doors: `GET /api/skills/:id` with a mission token (`skill_get`, `rooks
 * skill get`), and a tool call that opens the `SKILL.md` by its absolute path,
 * seen in the mission's stream. The UI and the CLI of the operator read skills
 * too (editor, injections view), and those reads say nothing about the
 * catalogue. A read neither door sees (a relative path, a remote backend) is
 * not counted: the count is a minimum, and on a backend without `skill_get` its
 * silence proves nothing (`unmeasured_missions`).
 */
import { existsSync } from 'node:fs';
import { backendCapabilities } from './backends/capabilities.js';
import { db, dbApi } from './db.js';
import { SKILLS_DIR, skillFile } from './paths.js';
import { ownerSql, type DbViewer } from './users/owned.js';

export const SKILL_READS_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows older than this are dropped: the widget reads 30 days, the rest is margin. */
const RETENTION_MS = 90 * DAY_MS;

export function recordSkillRead(read: { skill: string; missionId: string; agent: string; at?: number }): void {
  const at = read.at ?? Date.now();
  db.prepare('INSERT INTO skill_reads (skill, mission_id, agent, at) VALUES (?, ?, ?, ?)')
    .run(read.skill, read.missionId, read.agent, at);
  db.prepare('DELETE FROM skill_reads WHERE at < ?').run(at - RETENTION_MS);
}

/**
 * Journals a read by mission `missionId`, under the agent its row names. Never
 * throws: a journal that fails must not refuse the skill to the agent.
 */
export function journalMissionSkillRead(missionId: string, skill: string): void {
  try {
    const agent = dbApi.getMission(missionId)?.agent_name;
    if (agent) recordSkillRead({ skill, missionId, agent });
  } catch (err) {
    console.warn(`[skill-reads] could not journal ${skill}: ${(err as Error).message}`);
  }
}

const slashes = (text: string): string => text.replace(/\\+/g, '/');
/** What changes a file does not read it for the catalogue. */
const WRITING_TOOL = /write|edit|patch|replace/i;
/** Input fields that name what the tool opens. A message or a task description
 *  quoting the path is not a read, so free text stays out. */
const TARGET_FIELD = /path|file|command|cmd|uri/i;

/**
 * The skills the tool calls of an `assistant` event open by absolute path. Every
 * dialect normalizes its tool calls to `tool_use` blocks, so this holds for a
 * `Read` as for a `cat` in a shell, whatever the backend calls them.
 */
export function directSkillReads(payload: unknown): string[] {
  const content = (payload as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return [];
  const root = `${slashes(SKILLS_DIR)}/`;
  const skills: string[] = [];
  for (const block of content as { type?: unknown; name?: unknown; input?: unknown }[]) {
    if (block?.type !== 'tool_use' || typeof block.name !== 'string' || WRITING_TOOL.test(block.name)) continue;
    if (!block.input || typeof block.input !== 'object') continue;
    for (const [field, value] of Object.entries(block.input)) {
      if (!TARGET_FIELD.test(field)) continue;
      for (const after of slashes(JSON.stringify(value) ?? '').split(root).slice(1)) {
        const skill = /^([^/\s"'`]+)\/SKILL\.md/.exec(after)?.[1];
        if (skill) skills.push(skill);
      }
    }
  }
  return skills;
}

/** Journals the skills an `assistant` event opens directly. Never throws: it runs on the mission's stream. */
export function journalDirectSkillReads(missionId: string, payload: unknown): void {
  try {
    for (const skill of directSkillReads(payload)) {
      if (existsSync(skillFile(skill))) journalMissionSkillRead(missionId, skill);
    }
  } catch (err) {
    console.warn(`[skill-reads] could not read a tool call: ${(err as Error).message}`);
  }
}

export type SkillReadStats = {
  window_days: number;
  /** Missions of the agent started in the window, among those the viewer sees. */
  missions: number;
  /** Those that ran on a backend without the Rooks MCP: no read of theirs says the skill went unused. */
  unmeasured_missions: number;
  /** Per skill id: reads, and distinct missions that read it. A skill never read is absent. */
  skills: Record<string, { reads: number; missions: number }>;
};

/**
 * Reads of the agent's skills over the window, counted on the missions the
 * viewer may see (the same scoping as the mission list): a scoped user learns
 * nothing of another user's missions from the counter.
 */
export function skillReadStats(agent: string, viewer: DbViewer | null, agentBackend: string | null = null, now = Date.now()): SkillReadStats {
  const since = now - SKILL_READS_WINDOW_DAYS * DAY_MS;
  const owner = ownerSql(viewer, 'missions', 'm.owner_user_id');
  // A mission without an override ran on its agent's backend, as far as the row
  // tells: the one configured now stands in for the one configured then.
  const byBackend = db.prepare(
    `SELECT m.backend_override AS backend, COUNT(*) AS n FROM missions m
      WHERE m.agent_name = ? COLLATE NOCASE AND m.started_at >= ? AND ${owner.sql}
      GROUP BY m.backend_override`,
  ).all(agent, since, ...owner.params) as { backend: string | null; n: number }[];
  let missions = 0;
  let unmeasured = 0;
  for (const { backend, n } of byBackend) {
    missions += n;
    if (!backendCapabilities(backend || agentBackend).novaMcp) unmeasured += n;
  }
  const rows = db.prepare(
    `SELECT r.skill AS skill, COUNT(*) AS reads, COUNT(DISTINCT r.mission_id) AS missions
       FROM skill_reads r JOIN missions m ON m.id = r.mission_id
      WHERE r.agent = ? COLLATE NOCASE AND r.at >= ? AND ${owner.sql}
      GROUP BY r.skill`,
  ).all(agent, since, ...owner.params) as { skill: string; reads: number; missions: number }[];
  const skills: SkillReadStats['skills'] = {};
  for (const r of rows) skills[r.skill] = { reads: r.reads, missions: r.missions };
  return { window_days: SKILL_READS_WINDOW_DAYS, missions, unmeasured_missions: unmeasured, skills };
}
