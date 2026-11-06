import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { openInIsland } from '@/lib/island-bus';
import type { IslandContent, IslandParams } from './island-tree';
import type { SkillFormat, SkillSource } from './skill-sources';

/**
 * The skill content type of the island workspace, named apart from its
 * component (`components/skills/skill-island.tsx`): the Skills page opens a
 * skill without loading the editor.
 */
export const SKILL_ISLAND_KEY = 'skill';
export const SKILL_ISLAND_TYPE = `@timon/agents:${SKILL_ISLAND_KEY}`;

/**
 * Which entry of an id to open when it is not the winner: a skill masked by
 * another source of the same id. Absent, the daemon resolves the winner.
 */
export type SkillIslandOrigin = { source: SkillSource; format?: SkillFormat };

const SOURCES: readonly SkillSource[] = ['timon', 'claude-user', 'project', 'plugin'];
const FORMATS: readonly SkillFormat[] = ['timon', 'claude-skill', 'claude-cmd'];

/**
 * Only the id rides in the tab, never the file's path: the daemon resolves
 * the id to its file, and a proposal cannot point the island elsewhere. A
 * source names one of the registry's fixed roots, not a path.
 */
export function skillIslandContent(id: string, mode: 'preview' | 'edit' = 'preview', origin?: SkillIslandOrigin, section?: 'recipients'): IslandContent {
  const params: IslandParams = { id, mode };
  if (section) params.section = section;
  if (origin) {
    params.source = origin.source;
    if (origin.format) params.format = origin.format;
  }
  return { type: SKILL_ISLAND_TYPE, params };
}

/** The origin the params name, if any. */
export function skillIslandOrigin(params: IslandParams): SkillIslandOrigin | undefined {
  const source = SOURCES.find((s) => s === params.source);
  if (!source) return undefined;
  const format = FORMATS.find((f) => f === params.format);
  return format ? { source, format } : { source };
}

/** Opens a skill in a popup of the view's workspace; says so when there is none. */
export function openSkillIsland(id: string, mode: 'preview' | 'edit' = 'preview', origin?: SkillIslandOrigin, section?: 'recipients'): boolean {
  const opened = openInIsland(skillIslandContent(id, mode, origin, section), { edge: 'float' });
  if (!opened) toast.error(t('skillsPage.noWorkspace'));
  return opened;
}

// The island is not a child of the Skills page: a skill saved or deleted there
// tells the page, which reads its list again.
const changedListeners = new Set<() => void>();

export function onSkillsChanged(listener: () => void): () => void {
  changedListeners.add(listener);
  return () => { changedListeners.delete(listener); };
}

export function notifySkillsChanged(): void {
  for (const listener of changedListeners) listener();
}

/** The skill registry's id grammar (`orchestrator/src/skill-registry.ts`): never a separator, never `..`. */
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * `{ id, mode, source?, format?, section? }`: the id the daemon resolves, previewed
 * (default) or edited, and the source of a masked entry. An unknown source or
 * format is dropped, never passed on.
 */
export function parseSkillIslandParams(raw: unknown): IslandParams | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, mode, section } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !SKILL_ID.test(id) || id.includes('..')) return null;
  const origin = skillIslandOrigin(raw as IslandParams);
  return skillIslandContent(id, mode === 'edit' ? 'edit' : 'preview', origin, section === 'recipients' ? 'recipients' : undefined).params;
}
