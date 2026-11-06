/**
 * DIRECT write of a rule into `memory_rules` — the canonical gesture for
 * an agent to memorise something durably.
 *
 * Why this module exists. Until now, no living path allowed
 * inserting a rule: `memory-migrate.ts` imports `pieges.md` /
 * `instructions.md` / `decisions.md` ONLY if the table is empty (one-shot
 * bootstrap, never replayed since the first start), and the only other
 * channels were `learnings.jsonl` (raw facts, promoted later) and
 * the manual acceptance of a proposal in the /memory UI. Result observed
 * on 2026-08-24: an agent that wrote a pitfall in its `pieges.md` believed it was
 * memorising, while nothing was ever injected — neither right away, nor
 * after a rebuild.
 *
 * The logic lives here and not in the HTTP route to stay testable and
 * shared: CLI (`timon memory rule add`), MCP tool (`memory_rule_add`) and
 * the UI all go through the same route, which goes through this function.
 */
import { dbApi, type MemoryRuleRow } from './db.js';
import { emitMemoryRuleEvent, type PluginMemoryActor } from './memory-rule-events.js';
import { isPluginRuleSource, PLUGIN_RULE_SOURCE_PREFIX } from './memory-rule-origin.js';

export const RULE_SCOPES = ['agent', 'project', 'role', 'global'] as const;
export const RULE_KINDS = ['pitfall', 'decision', 'preference'] as const;

export type AddRuleInput = {
  scope?: string;
  project?: string | null;
  agent?: string | null;
  role?: string | null;
  kind?: string;
  text?: string;
  tier?: string;
  source?: string;
};

/** Error carrying an HTTP status, so the route relays it without guessing. */
export class MemoryRuleError extends Error {
  status: number;
  duplicate?: MemoryRuleRow;
  constructor(message: string, status: number, duplicate?: MemoryRuleRow) {
    super(message);
    this.status = status;
    this.duplicate = duplicate;
  }
}

/** The writer of an addition, for the lifecycle event. */
export type AddRuleOptions = {
  /**
   * Trusted origin mark (`plugin:<id>`), set by `ctx.memory` only. A `source`
   * carried by the payload can never take the plugin prefix.
   */
  pluginSource?: string;
  actor?: PluginMemoryActor;
};

/**
 * Validates, deduplicates and inserts. Returns the created rule.
 * Throws `MemoryRuleError` (400 validation, 409 duplicate).
 */
export function addMemoryRule(input: AddRuleInput, opts: AddRuleOptions = {}): MemoryRuleRow {
  if (typeof input.source === 'string' && isPluginRuleSource(input.source)) {
    throw new MemoryRuleError(`source: the \`${PLUGIN_RULE_SOURCE_PREFIX}\` prefix is reserved for plugins`, 400);
  }
  const scope = (input.scope || 'agent').trim();
  if (!(RULE_SCOPES as readonly string[]).includes(scope)) {
    throw new MemoryRuleError(`invalid scope '${scope}' — expected: ${RULE_SCOPES.join('|')}`, 400);
  }
  const kind = (input.kind || 'pitfall').trim();
  if (!(RULE_KINDS as readonly string[]).includes(kind)) {
    throw new MemoryRuleError(`invalid kind '${kind}' — expected: ${RULE_KINDS.join('|')}`, 400);
  }
  const text = (input.text ?? '').trim();
  if (!text) throw new MemoryRuleError('text is required and cannot be empty', 400);

  // A rule is injected through its scope; without a target, it would never
  // reach anyone (scope=agent without an agent = invisible orphan rule).
  const agent = scope === 'agent' ? (input.agent || '').trim() : null;
  const project = scope === 'project' ? (input.project || '').trim() : null;
  const role = scope === 'role' ? (input.role || '').trim() : null;
  if (scope === 'agent' && !agent) throw new MemoryRuleError("scope=agent requires 'agent'", 400);
  // Reserved for a trashed agent's parked memory (TODO #670): a rule written
  // there would come back with a restore no one asked for.
  if (agent?.toLowerCase().startsWith('trash:')) throw new MemoryRuleError("agent: the `trash:` prefix is reserved", 400);
  if (scope === 'project' && !project) throw new MemoryRuleError("scope=project requires 'project'", 400);
  if (scope === 'role' && !role) throw new MemoryRuleError("scope=role requires 'role'", 400);

  const tier = (input.tier || 'normal').trim();
  if (tier !== 'normal' && tier !== 'core') {
    throw new MemoryRuleError(`invalid tier '${tier}' — expected: normal|core`, 400);
  }

  const dup = dbApi.findActiveRuleByText({ scope, project, agent, role, text });
  if (dup) {
    throw new MemoryRuleError(
      `rule already present (id ${dup.id}) on this scope — nothing inserted`,
      409,
      dup,
    );
  }

  const id = dbApi.insertRule({
    scope, project, agent, role, kind, text, tier,
    source: opts.pluginSource ?? (input.source || 'manual'),
  });
  dbApi.logMemoryAudit({
    scope, project, agent, action: 'manual_add', ruleId: id, candidateText: text,
    rationale: `ajout direct (source=${input.source || 'manual'})`,
  });
  const rule = dbApi.getRule(id) as MemoryRuleRow;
  emitMemoryRuleEvent('memory_rule_added', rule, opts.actor ?? { kind: 'manual', id: null });
  return rule;
}
