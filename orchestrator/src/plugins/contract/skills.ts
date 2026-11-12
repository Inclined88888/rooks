

// Moved from `plugins/skills-facade.ts`, which re-exports it (TODO #512, volet 3).
export type ScopedSkills = {
  list(): Promise<PluginSkillSummary[]>;
  /** `undefined` when the skill does not exist (or is not visible to a job). */
  get(id: string): Promise<PluginSkill | undefined>;
  put(id: string, content: string): Promise<PluginSkill>;
  /** `true` when the skill existed. */
  rm(id: string): Promise<boolean>;
};
/** Public plugin types, extracted from the host implementations (TODO #512). */
export type PluginSkillSummary = {
  id: string;
  title: string;
  size: number;
  updatedAt: number;
  /** Created by THIS plugin: `put` and `rm` accept it. */
  mine: boolean;
  /** A skill of the product: read-only for every plugin. */
  product: boolean;
};

export type PluginSkill = PluginSkillSummary & { content: string };

export type PluginSkillErrorCode = 'invalid' | 'not_found' | 'forbidden';
