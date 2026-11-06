/** Public plugin types, extracted from the host implementations (TODO #512). */
/** One rule of a series: a fallback target, or a per-type LLM choice. */
export type PluginSeriesRule = Readonly<{
  /** `orchestrator`, `*` or a task type for a fallback; a task type for a role choice. */
  scope: string;
  /** `null` on a fallback means "this scope does not fall back". */
  backend: string | null;
  model: string | null;
  updatedAt: number;
  /** Group of volets of the series plan the rule governs; `null` = the whole
   *  series. A task of a group resolves on its group's rules first. */
  planGroup: string | null;
}>;

export type PluginSeriesFallbackInput = {
  scope: string;
  /** `null` = this scope never falls back (not the same as setting nothing). */
  backend: string | null;
  model?: string;
  /** Apply the rule at once to the PENDING/BLOCKED tasks of the scope. Default true. */
  apply?: boolean;
  /** Group of volets the rule governs (≤ 60 chars); absent = the whole series.
   *  Never on `orchestrator`. */
  group?: string | null;
};

export type PluginSeriesFallbackResult = Readonly<{
  rules: readonly PluginSeriesRule[];
  /** The target the pending tasks were moved to, or `null` (nothing to move, or `apply: false`). */
  applied: { backend: string; model: string | null } | null;
  /** The rule is recorded even when applying it failed; the reason is here. */
  applyError: string | null;
}>;

export type PluginSeriesRoleInput = {
  /** A task type: `code`, `review`, `merge`, `research`, `doc` or `chore`. */
  scope: string;
  backend?: string;
  model?: string;
  /** Group of volets the choice governs (≤ 60 chars); absent = the whole series. */
  group?: string | null;
};

/** `invalid` (input), `not_found` (no such series, or not in the caller's view), `forbidden` (a refusal of the caller's rights). */
export type PluginSeriesErrorCode = 'invalid' | 'not_found' | 'forbidden';
