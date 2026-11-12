/**
 * The skills of one agent as the editor shows them, and the attachment writes
 * that make the daemon agree after a save (`/api/skill-attachments`).
 *
 * A checked skill is an agent-scope attachment: `include` (catalogue) or
 * `import`. The editor no longer writes `config.skills`; the agent's `skills`
 * field still lists an old config's entries until the daemon moves them.
 * The inherited list can write an agent exclusion immediately; saving the
 * checked skills preserves it, just like exclusions set on the skill's page.
 */

export type SkillMode = 'include' | 'import';
export type SkillVia = 'global' | 'project' | 'role' | 'agent' | 'config' | 'code';

export type SkillAttachment = {
  id: number;
  skill: string;
  scope: 'global' | 'project' | 'role' | 'agent';
  target: string;
  mode: SkillMode;
  exclude: boolean;
};

export type ResolvedSkill = { id: string; mode: SkillMode; via: SkillVia };

/** The mode of each skill the agent itself holds, read from its own attachments. */
export function agentSkillModes(own: SkillAttachment[]): Record<string, SkillMode> {
  const modes: Record<string, SkillMode> = {};
  for (const a of own) if (a.scope === 'agent' && !a.exclude) modes[a.skill] = a.mode;
  return modes;
}

/** The agent's `skills` plus its own attachments: the editor shows them checked. */
export function checkedSkills(configSkills: string[], own: SkillAttachment[]): string[] {
  const out = [...configSkills];
  for (const a of own) if (a.scope === 'agent' && !a.exclude && !out.includes(a.skill)) out.push(a.skill);
  return out;
}

/** Skills that reach the agent from a wider scope. */
export function inheritedSkills(resolved: ResolvedSkill[]): ResolvedSkill[] {
  return resolved.filter((s) => s.via === 'global' || s.via === 'project' || s.via === 'role');
}

export type AttachmentSync = {
  attach: { skill: string; mode: SkillMode }[];
  detach: number[];
};

/**
 * What to write so the agent's own attachments say what the editor shows: one
 * attachment per checked skill, in its mode (an existing one rewritten when the
 * mode changed), none for an unchecked one. A skill the agent excludes is left
 * excluded, checked or not.
 */
export function attachmentSync(
  checked: string[],
  modes: Record<string, SkillMode>,
  own: SkillAttachment[],
): AttachmentSync {
  const attach: AttachmentSync['attach'] = [];
  const detach: number[] = [];
  const mine = own.filter((a) => a.scope === 'agent');
  const excluded = new Set(mine.filter((a) => a.exclude).map((a) => a.skill));
  const byskill = new Map(mine.filter((a) => !a.exclude).map((a) => [a.skill, a]));
  for (const skill of checked) {
    if (excluded.has(skill)) continue;
    const want = modes[skill] ?? 'include';
    if (byskill.get(skill)?.mode !== want) attach.push({ skill, mode: want });
  }
  for (const [skill, a] of byskill) if (!checked.includes(skill)) detach.push(a.id);
  return { attach, detach };
}

/** Tokens of one skill in each mode, measured by the daemon on the text the spawn sends (`GET /api/skill-weights`).
 * `pasted` / `left_out` describe what a backend unable to read on demand receives. */
export type SkillWeight = { include: number; import: number; on_demand: number; pasted?: number; left_out?: string[] };
export type SkillWeights = {
  weights: Record<string, SkillWeight>;
  /** Paid once per prompt by the first skill of each mode; absent on older daemons. */
  headings?: Record<SkillMode, number>;
};

/**
 * What a spawn would send once the draft is saved, resolved by the daemon with
 * the spawn's own code (`POST /api/skill-attachments/preview`): the client adds
 * nothing up, so exclusions and attachments of every scope are already in it.
 */
export type SkillsPreview = {
  /** `tokens` / `left_out`: this skill within the prompt, budget shared with the skills before it. Absent on older daemons. */
  skills: (ResolvedSkill & { tokens?: number; left_out?: string[] })[];
  /** Checked, yet kept out by the agent's own exclusion. */
  excluded: string[];
  skills_tokens: number;
  on_demand_tokens: number;
  /** The whole prompt; null for an agent not created yet. */
  prompt_tokens: number | null;
};

/** The editor's fields that change what a spawn sends. */
export type SkillsPreviewDraft = {
  skills: string[];
  role: string;
  project: string;
  cwd: string;
  backend: string;
  model: string;
  globalContext: boolean;
  systemPrompt: string;
};

// The daemon's own charset (a folder name): anything else never reaches a prompt.
const SKILL_ID = /^[a-z0-9._-]+$/;

/** The draft as a save would write it (`save()` in the editor), for the preview route. */
export function skillsPreviewBody(agent: string | null, draft: SkillsPreviewDraft, modes: Record<string, SkillMode>) {
  return {
    ...(agent ? { agent } : {}),
    skills: draft.skills.filter((id) => SKILL_ID.test(id)).map((id) => ({ id, mode: modes[id] ?? 'include' })),
    role: draft.role || 'coder',
    project: draft.project,
    cwd: draft.cwd,
    backend: draft.backend,
    model: draft.model,
    global_context: draft.globalContext,
    // A new agent has no prompt to measure, so its text would be sent for nothing.
    ...(agent ? { system_prompt: draft.systemPrompt } : {}),
  };
}

/**
 * The same skills as the spawn sends them: on a backend that cannot read one on
 * demand, every skill is pasted whole. For display only: the attachment keeps
 * its mode, so the choice comes back on a backend that can honour it.
 */
export function effectiveSkills<T extends { mode: SkillMode }>(skills: T[], readsOnDemand: boolean): T[] {
  return readsOnDemand ? skills : skills.map((s) => ({ ...s, mode: 'import' }));
}

/**
 * The weights this backend pays: a remote backend receives the body and its
 * eligible neighbour files. The weights measure a skill alone; what the preview
 * resolved wins, since the skills of one prompt share a budget for their files.
 */
export function weightsOnBackend(w: SkillWeights, readsOnDemand: boolean, preview?: SkillsPreview | null): SkillWeights {
  if (readsOnDemand) return w;
  const weights: Record<string, SkillWeight> = {};
  for (const [id, weight] of Object.entries(w.weights)) weights[id] = { ...weight, import: weight.pasted ?? weight.import };
  for (const s of preview?.skills ?? []) {
    const weight = weights[s.id];
    if (!weight) continue;
    weights[s.id] = { ...weight, import: s.tokens ?? weight.import, left_out: s.left_out ?? weight.left_out };
  }
  return { ...w, weights };
}


/** The route's answer, or null when it is not one: no figure rather than a wrong one. */
export function parseSkillsPreview(value: unknown): SkillsPreview | null {
  const v = value as Partial<SkillsPreview> | null;
  if (!v || !Array.isArray(v.skills) || !Array.isArray(v.excluded)) return null;
  if (typeof v.skills_tokens !== 'number' || typeof v.on_demand_tokens !== 'number') return null;
  if (typeof v.prompt_tokens !== 'number' && v.prompt_tokens !== null) return null;
  return {
    skills: v.skills, excluded: v.excluded, skills_tokens: v.skills_tokens,
    on_demand_tokens: v.on_demand_tokens, prompt_tokens: v.prompt_tokens ?? null,
  };
}

/*
 * Who receives one skill: the section of a Rooks skill's island that lists and
 * edits its attachments at every scope (`GET /api/skill-attachments?skill=`).
 */

export type AttachmentScope = SkillAttachment['scope'];

/** Widest first, the order the daemon resolves them in: the narrowest that names a skill decides. */
export const ATTACHMENT_SCOPES: readonly AttachmentScope[] = ['global', 'project', 'role', 'agent'];

/** What an attachment does: a catalogue line, the body pasted whole, or an exclusion. */
export type AttachmentKind = SkillMode | 'exclude';

export function attachmentKind(a: Pick<SkillAttachment, 'mode' | 'exclude'>): AttachmentKind {
  return a.exclude ? 'exclude' : a.mode;
}

/** The kinds a scope accepts: nothing is wider than global, so it has nothing to exclude. */
export function attachmentKinds(scope: AttachmentScope): AttachmentKind[] {
  return scope === 'global' ? ['include', 'import'] : ['include', 'import', 'exclude'];
}

export type ScopeGroup = { scope: AttachmentScope; rows: SkillAttachment[] };

/** The skill's attachments by scope, widest first, each scope sorted by target; empty scopes are left out. */
export function attachmentGroups(attachments: SkillAttachment[], skill: string): ScopeGroup[] {
  const mine = attachments.filter((a) => a.skill === skill);
  return ATTACHMENT_SCOPES
    .map((scope) => ({
      scope,
      rows: mine.filter((a) => a.scope === scope).sort((a, b) => a.target.localeCompare(b.target)),
    }))
    .filter((g) => g.rows.length > 0);
}

/** What `/api/auth/me` says of the two grants an attachment write needs;
 *  `null` while it is being read. */
export type AttachmentGrants = { manage: boolean | null; privileged: boolean | null };

/**
 * Whether the account may write at this scope, as far as `/api/auth/me` says:
 * `true`, `false`, or `null` while it is being read. Every write needs
 * `agents:manage`; global, project and role reach agents the caller may not
 * see, hence `agents:privileged-config` on top. The route still decides.
 */
export function scopeWritable(scope: AttachmentScope, grants: AttachmentGrants): boolean | null {
  const needed = scope === 'agent' ? [grants.manage] : [grants.manage, grants.privileged];
  if (needed.includes(false)) return false;
  return needed.includes(null) ? null : true;
}

/** The targets still free at `scope` for this skill: one attachment per (skill, scope, target). */
export function freeTargets(scope: AttachmentScope, known: string[], attachments: SkillAttachment[], skill: string): string[] {
  if (scope === 'global') return [];
  const taken = new Set(attachments.filter((a) => a.skill === skill && a.scope === scope).map((a) => a.target));
  return [...new Set(known)].filter((t) => t !== '' && !taken.has(t)).sort((a, b) => a.localeCompare(b));
}

/** Whether global already holds this skill: the global scope has a single target. */
export function globalTaken(attachments: SkillAttachment[], skill: string): boolean {
  return attachments.some((a) => a.skill === skill && a.scope === 'global');
}

export type AttachBody = { skill: string; scope: AttachmentScope; target?: string; mode: SkillMode; exclude: boolean };

/** The POST body of `/api/skill-attachments`; an exclusion keeps the default mode, which it does not use. */
export function attachBody(skill: string, scope: AttachmentScope, target: string, kind: AttachmentKind): AttachBody {
  return {
    skill,
    scope,
    ...(scope === 'global' ? {} : { target }),
    mode: kind === 'exclude' ? 'include' : kind,
    exclude: kind === 'exclude',
  };
}

/** An i18n key under `skillAttach.` and its variables. */
export type AttachFailure = { key: string; vars?: Record<string, string> };

/**
 * What to tell the user when a write is refused. The daemon answers 404 with
 * `<what> not found: <name>` for a target or a skill that does not exist, and
 * 403 with a `reason` that names the missing permission.
 */
export function attachFailure(status: number, body: unknown, target: { scope: AttachmentScope; target: string }): AttachFailure {
  const b = body && typeof body === 'object' ? body as { error?: unknown; reason?: unknown } : {};
  const error = typeof b.error === 'string' ? b.error : '';
  if (status === 401) return { key: 'unauthorized' };
  if (status === 403) {
    const reason = typeof b.reason === 'string' ? b.reason : '';
    return reason ? { key: 'forbiddenReason', vars: { reason } } : { key: 'forbidden' };
  }
  if (status === 404) {
    const what = /^(project|role|agent|skill|skill attachment) not found/.exec(error)?.[1];
    if (what === 'project' || what === 'role' || what === 'agent') return { key: `notFound.${what}`, vars: { target: target.target } };
    if (what === 'skill') return { key: 'notFound.skill' };
    if (what === 'skill attachment') return { key: 'notFound.attachment' };
    return { key: 'notFound.unknown' };
  }
  if (status === 400) return { key: 'invalid' };
  return { key: 'failed' };
}
