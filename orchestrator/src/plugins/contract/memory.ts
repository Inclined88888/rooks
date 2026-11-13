/** Public plugin types, extracted from the host implementations (TODO #512). */

// Moved from `memory-queries.ts`, which re-exports it (TODO #512, volet 3).
export type MemoryOverview = {
  counts: { facts: number; pitfalls: number; rules: number; pending: number; projects: number };
  proposals: {
    id: number; hash: string; slug: string | null; scope: string; kind: string; text: string;
    rationale: string | null; count: number; ts: string;
  }[];
};

export type MemorySearchResult = {
  q: string;
  count: number;
  truncated?: boolean;
  hits: { scope: string; id: string; file: string; kind: string; text: string }[];
};

/** A rule as a plugin sees it. */
export type PluginMemoryRule = Readonly<{
  id: number;
  scope: string;
  project: string | null;
  agent: string | null;
  role: string | null;
  kind: string;
  tier: string;
  status: string;
  text: string;
  createdAt: number;
  /** `manual`, `synthesis` or `plugin:<id>`. */
  source: string;
  /** Written by THIS plugin: `rules.rm` accepts it. */
  mine: boolean;
}>;

export type PluginMemoryRuleInput = {
  text: string;
  /** `agent` (default), `project`, `role` or `global`. */
  scope?: 'agent' | 'project' | 'role' | 'global';
  /** The target of the scope: the agent name, the project slug or the role. */
  agent?: string;
  project?: string;
  role?: string;
  /** `pitfall` (default), `decision` or `preference`. */
  kind?: 'pitfall' | 'decision' | 'preference';
  /** `normal` (default) or `core` (superadmin caller only). */
  tier?: 'normal' | 'core';
};

export type PluginMemoryRuleFilter = { scope?: string; project?: string; agent?: string };

export type PluginMemoryFileInfo = Readonly<{ name: string; size: number; modified: number }>;

export type PluginMemoryFile = Readonly<{ name: string; content: string }>;

export type PluginMemoryTargetScope = 'agent' | 'project';

export type PluginMemoryOverview = MemoryOverview;

export type PluginMemorySearchResult = MemorySearchResult;

/** `code` of `PluginMemoryError`: `invalid` (input), `not_found`, `conflict`
 *  (the rule already exists on that scope), `forbidden` (not this plugin's
 *  rule, or a scope reserved to a superadmin). */
export type PluginMemoryErrorCode = 'invalid' | 'not_found' | 'conflict' | 'forbidden';

export type PluginMemoryEventKind = 'memory_rule_added' | 'memory_rule_removed';

/** Who acted: `user` (account id), `agent` (name), `plugin` (plugin id), `system`. */
export type PluginMemoryActor = Readonly<{ kind: string; id: string | null }>;

/** The rule as the event carries it, at the time of the write. */
export type PluginMemoryRuleSnapshot = Readonly<{
  id: number;
  scope: string;
  project: string | null;
  agent: string | null;
  role: string | null;
  kind: string;
  tier: string;
  text: string;
}>;

export type PluginMemoryRuleAddedEvent = Readonly<{
  kind: 'memory_rule_added';
  ruleId: number;
  rule: PluginMemoryRuleSnapshot;
  /** Who wrote it: this plugin, since only its own rules come back. */
  origin: PluginMemoryActor;
}>;

export type PluginMemoryRuleRemovedEvent = Readonly<{
  kind: 'memory_rule_removed';
  ruleId: number;
  rule: PluginMemoryRuleSnapshot;
  /** Who removed it: the plugin itself, a user, an agent. */
  origin: PluginMemoryActor;
}>;

export type PluginMemoryEvent = PluginMemoryRuleAddedEvent | PluginMemoryRuleRemovedEvent;

export type PluginMemoryEventMap = {
  memory_rule_added: PluginMemoryRuleAddedEvent;
  memory_rule_removed: PluginMemoryRuleRemovedEvent;
};

export type PluginMemoryEventHandler = (ev: PluginMemoryEvent) => void | Promise<void>;
