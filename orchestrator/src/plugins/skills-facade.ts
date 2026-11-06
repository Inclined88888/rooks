/**
 * `ctx.skills`: the Timon skills a plugin lists, reads, writes and removes —
 * `~/.timon/skills/<id>/SKILL.md`, the instructions an agent loads
 * (`agents.update({ skills })`).
 *
 * A skill is injected into the missions that load it, so a plugin faces the
 * rules of a mission that is not the operator (`nonOperatorSkillRefusal`), and
 * its code is never "the operator", whoever the caller is:
 *
 *  - a skill is written by id under the Timon skills folder, never by path;
 *  - a product skill (`timon-task` & co) is never written or removed;
 *  - `allowed_tools` in the frontmatter pre-authorises tools: refused;
 *  - a plugin overwrites and removes only the skills IT created, marked beside
 *    the skill (`.created-by`); a superadmin caller may also touch another's,
 *    but never a product skill. A job also READS only its own.
 *
 * Reading a skill is not sensitive (a request sees what the page lists), so
 * `skills:read` is its own permission, apart from `skills:write`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { skillDir, skillFile } from '../paths.js';
import { deleteSkill, getSkill, isSystemSkillId, listSkills, upsertSkill } from '../skills.js';
import { nonOperatorSkillRefusal } from '../users/skills-mcp-guard.js';
import { pluginAgentOrigin } from './agent-origin.js';

import type { PluginSkillSummary, PluginSkillErrorCode, ScopedSkills } from './contract/skills.js';
export type { ScopedSkills } from './contract/skills.js';
export type { PluginSkillSummary, PluginSkill, PluginSkillErrorCode } from './contract/skills.js';

export class PluginSkillError extends Error {
  constructor(readonly code: PluginSkillErrorCode, message: string) {
    super(message);
    this.name = 'PluginSkillError';
  }
}

export type SkillCallerScope = {
  pluginId: string;
  /** No request: the plugin acts as itself and sees only its own skills. */
  job: boolean;
  /** The request's caller is a superadmin: may touch a skill another plugin created. */
  superadmin: boolean;
};

/** Beside `SKILL.md`: the skill loader reads that file only. */
const MARK = '.created-by';
const MAX_BYTES = 1024 * 1024;

const IdSchema = z.string().min(1).max(100).regex(/^[a-z0-9._-]+$/, 'invalid skill id')
  .refine((id) => id !== '.' && id !== '..' && !id.endsWith('.'), 'invalid skill id');
const ContentSchema = z.string().refine((c) => c.trim().length > 0, 'empty content (to delete the skill: rm)')
  .refine((c) => Buffer.byteLength(c, 'utf8') <= MAX_BYTES, `skill too large (max ${MAX_BYTES} bytes)`);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) throw new PluginSkillError('invalid', res.error.issues[0]?.message ?? 'invalid input');
  return res.data;
}

const markFile = (id: string): string => join(skillDir(id), MARK);

function creatorOf(id: string): string | null {
  try {
    return existsSync(markFile(id)) ? readFileSync(markFile(id), 'utf8').trim() || null : null;
  } catch {
    return null;
  }
}

export function skillsFor(scope: SkillCallerScope): ScopedSkills {
  const origin = pluginAgentOrigin(scope.pluginId);
  const mine = (id: string): boolean => creatorOf(id) === origin;
  const summary = (s: { id: string; title: string; size: number; updated_at: number }): PluginSkillSummary => ({
    id: s.id, title: s.title, size: s.size, updatedAt: s.updated_at, mine: mine(s.id), product: isSystemSkillId(s.id),
  });
  /** A job answers `not_found` for what it did not create. */
  const visible = (id: string): boolean => !scope.job || mine(id);
  const existing = (id: string) => {
    try { return getSkill(id); } catch { return null; }
  };
  /** The rules a non-operator caller is held to, whoever owns the skill. */
  const assertAllowed = (id: string, content?: string): void => {
    const refusal = nonOperatorSkillRefusal({ path: skillFile(id), content }, false);
    if (refusal) throw new PluginSkillError('forbidden', refusal);
  };
  /** A job answers `not_found` for what it did not create; a request is told. */
  const assertOwned = (id: string): void => {
    if (!existing(id) || mine(id)) return;
    if (scope.job) throw new PluginSkillError('not_found', `skill not found: ${id}`);
    if (!scope.superadmin) throw new PluginSkillError('forbidden', `skill ${id} was not created by this plugin`);
  };

  return {
    async list() {
      return listSkills().filter((s) => visible(s.id)).map(summary);
    },

    async get(id) {
      const skill = existing(parse(IdSchema, id));
      if (!skill || !visible(skill.id)) return undefined;
      return { ...summary(skill), content: skill.content };
    },

    async put(id, content) {
      const skillId = parse(IdSchema, id);
      const text = parse(ContentSchema, content);
      assertAllowed(skillId, text);
      assertOwned(skillId);
      const fresh = !existing(skillId);
      const saved = upsertSkill(skillId, text);
      if (fresh) writeFileSync(markFile(skillId), origin);
      return { ...summary(saved), content: saved.content };
    },

    async rm(id) {
      const skillId = parse(IdSchema, id);
      assertAllowed(skillId);
      if (!existing(skillId)) return false;
      assertOwned(skillId);
      return deleteSkill(skillId);
    },
  };
}
