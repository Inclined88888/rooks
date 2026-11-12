import { BRAND } from '@/lib/brand';
import { t } from '@/lib/i18n';

/** What `/api/skills` lists (`orchestrator/src/skill-registry.ts` `SkillEntry`). */
export type SkillSource = 'rooks' | 'claude-user' | 'project' | 'plugin';
export type SkillFormat = 'rooks' | 'claude-skill' | 'claude-cmd';

export type Skill = {
  id: string;
  title: string;
  description?: string;
  source: SkillSource;
  format: SkillFormat;
  scope: 'global' | 'project';
  path: string;
  editable: boolean;
  shadowed?: boolean;
  size: number;
  updated_at: number;
};

export type SkillDetail = Skill & { content: string };

/** The colours of a source's badge, the same on the cards and in the island. */
export const SKILL_SOURCE_CLASS: Record<SkillSource, string> = {
  rooks: 'bg-primary/15 text-primary border-primary/30',
  'claude-user': 'bg-sky-500/15 text-sky-500 border-sky-500/30',
  project: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
  plugin: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
};

export function skillSourceLabel(source: SkillSource): string {
  return source === 'rooks' ? BRAND.displayName : t(`skillsPage.source.${source}`);
}
