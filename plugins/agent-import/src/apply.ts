/**
 * Executing a plan, agent by agent, through the facades only.
 *
 * Each agent is a unit: every write it needs is recorded with its undo, and if
 * one fails the agent and what was written for it are removed, in reverse
 * order, while the next agents go on. An agent that already existed (a
 * re-import) is never removed: only what this run added for it is.
 *
 * Nothing imported is run: prompts, skills and routine instructions are
 * stored as text, and routine instructions reach a task verbatim (`raw`),
 * never through the trigger templates.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_IMPORT_ROLE, type ApplyResponse, type ImportResultAgent } from './contract.js';
import { publishApplied } from './event.js';
import type { AgentPlan, EngineContext, ImportPlan } from './plan.js';
import { FINGERPRINTED_DOCS, fingerprint, type ImportRecord, type OwnedRecord, type Records } from './records.js';

const ERROR_MAX = 300;

type Undo = { what: string; run: () => Promise<unknown> };

const errorText = (err: unknown): string =>
  (err instanceof Error && err.message ? err.message : 'unknown error').replace(/\s+/g, ' ').slice(0, ERROR_MAX);

const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

export async function applyPlan(ctx: EngineContext, records: Records, plan: ImportPlan): Promise<ApplyResponse> {
  const importId = randomUUID();
  /** Teams made by this run, by group key: one team per group, whichever agent comes first. */
  const teams = new Map<string, string>();
  const results: ImportResultAgent[] = [];

  for (const agent of plan.agents) {
    const base = { sourceRef: agent.source.sourceRef, displayName: agent.source.displayName };
    if (agent.action === 'skip') {
      results.push({ ...base, agent: agent.record ? agent.finalName : null, status: 'skipped', warnings: agent.warnings });
      continue;
    }
    const warnings = [...agent.warnings];
    const undo: Undo[] = [];
    try {
      await applyAgent(ctx, records, plan.sourceApp, agent, teams, undo, warnings);
    } catch (err) {
      const failures = await rollback(ctx, undo);
      if (failures.length > 0) warnings.push(`Could not undo everything: ${failures.join(', ')}.`);
      ctx.log.warn(`import of ${agent.finalName} failed and was rolled back:`, errorText(err));
      results.push({
        ...base,
        agent: agent.action === 'update' ? agent.finalName : null,
        status: 'failed',
        error: errorText(err),
        warnings,
      });
      continue;
    }
    try {
      await publishApplied(ctx, importId, { sourceRef: agent.source.sourceRef, agent: agent.finalName, sourceApp: plan.sourceApp });
    } catch (err) {
      // The agent is imported: a subscriber's trouble does not undo it.
      ctx.log.warn('agent-import:applied could not be published:', errorText(err));
    }
    results.push({ ...base, agent: agent.finalName, status: agent.action === 'update' ? 'updated' : 'created', warnings });
  }
  return { agents: results, warnings: plan.warnings };
}

async function rollback(ctx: EngineContext, undo: Undo[]): Promise<string[]> {
  const failures: string[] = [];
  for (const step of undo.reverse()) {
    try { await step.run(); } catch (err) {
      failures.push(step.what);
      ctx.log.warn(`rollback of ${step.what} failed:`, errorText(err));
    }
  }
  return failures;
}

async function applyAgent(
  ctx: EngineContext,
  records: Records,
  sourceApp: string,
  plan: AgentPlan,
  teams: Map<string, string>,
  undo: Undo[],
  warnings: string[],
): Promise<void> {
  const name = plan.finalName;
  const creating = plan.action === 'create';

  // A skill or server reused keeps the account that imported it first.
  const ownerOf = (owned: OwnedRecord | null): string | null =>
    (owned && owned.ownerUserId !== undefined ? owned.ownerUserId : plan.ownerUserId);

  const skillIds: string[] = [];
  for (const skill of plan.skills) {
    const before = await ctx.skills.get(skill.finalId);
    const existed = before !== undefined;
    const owned = existed ? await records.skill(skill.finalId) : null;
    await ctx.skills.put(skill.finalId, skill.content);
    if (!existed) {
      undo.push({ what: `skill ${skill.finalId}`, run: async () => { await ctx.skills.rm(skill.finalId); await records.dropSkill(skill.finalId); } });
    } else if (before.content !== skill.content) {
      undo.push({ what: `skill ${skill.finalId}`, run: () => ctx.skills.put(skill.finalId, before.content) });
    }
    await records.putSkill(skill.finalId, { sourceApp, sourceId: skill.sourceId, ownerUserId: ownerOf(owned) });
    if (!skillIds.includes(skill.finalId)) skillIds.push(skill.finalId);
  }

  const serverIds: string[] = [];
  for (const server of plan.mcp) {
    const existed = (await ctx.mcpServers.get(server.finalId)) !== undefined;
    const owned = existed ? await records.mcp(server.finalId) : null;
    await ctx.mcpServers.put(server.finalId, {
      name: server.name,
      description: `Imported from ${sourceApp}.`,
      transport: { type: 'http', url: server.url },
    });
    if (!existed) {
      undo.push({ what: `MCP server ${server.finalId}`, run: async () => { await ctx.mcpServers.rm(server.finalId); await records.dropMcp(server.finalId); } });
    }
    await records.putMcp(server.finalId, { sourceApp, sourceId: server.name, ownerUserId: ownerOf(owned) });
    if (!serverIds.includes(server.finalId)) serverIds.push(server.finalId);
  }

  // What came from the source (role, project, directory, backend, model) may
  // not exist or be allowed here: refused, the agent is made with Rooks's defaults.
  const settings = (fallback: boolean) => ({
    ...(plan.setRole ? { role: fallback && plan.fromSource.role ? DEFAULT_IMPORT_ROLE : plan.role } : {}),
    ...(typeof plan.project === 'string' && !(fallback && plan.fromSource.project) ? { project: plan.project } : {}),
    ...(plan.project === null ? { project: null } : {}),
    ...(plan.cwd && !(fallback && plan.fromSource.cwd) ? { cwd: plan.cwd } : {}),
    ...(plan.backend && !fallback ? { backend: plan.backend } : {}),
    ...(plan.backend && plan.model && !fallback ? { model: plan.model } : {}),
  });
  const fromSource = plan.fromSource.role || plan.fromSource.project || plan.fromSource.cwd || plan.backend !== null;
  if (!creating) {
    // An update that fails gives the agent back its prompt and documents. Its
    // directives, settings, picture and MCP servers are not readable through
    // the facades: those stay as the import left them (see the README).
    const prompt = await ctx.agents.docs.get(name, 'system-prompt.md');
    const written = [...(plan.soul !== null ? ['SOUL.md'] : []), ...plan.docs.map((d) => d.name)];
    const docsBefore = await Promise.all(written.map(async (file) => [file, await ctx.agents.docs.get(name, file)] as const));
    undo.push({
      what: `documents of ${name}`,
      run: async () => {
        await ctx.agents.update(name, { systemPrompt: prompt ?? '' });
        for (const [file, content] of docsBefore) {
          if (content) await ctx.agents.docs.put(name, file, content);
          else await ctx.agents.docs.rm(name, file);
        }
      },
    });
  }
  const write = async (fallback: boolean): Promise<void> => {
    if (creating) {
      await ctx.agents.create({
        name,
        systemPrompt: plan.systemPrompt,
        role: plan.role,
        ...(plan.directives !== null ? { directives: plan.directives } : {}),
        ...settings(fallback),
        ...(plan.selected.skills ? { skills: skillIds } : {}),
        ...(plan.selected.mcp ? { mcpServers: serverIds } : {}),
      });
    } else {
      await ctx.agents.update(name, {
        systemPrompt: plan.systemPrompt,
        ...(plan.directives !== null ? { directives: plan.directives } : {}),
        ...settings(fallback),
        ...(plan.selected.skills ? { skills: skillIds } : {}),
        ...(plan.selected.mcp ? { mcpServers: serverIds } : {}),
      });
    }
  };
  try {
    await write(false);
  } catch (err) {
    const code = codeOf(err);
    if (!fromSource || (code !== 'invalid' && code !== 'forbidden')) throw err;
    await write(true);
    warnings.push(`The settings of the source were refused here (${errorText(err)}): the agent uses Rooks's defaults for them.`);
  }
  // Purged, not trashed: nothing of a half-imported agent may be restored.
  if (creating) undo.push({ what: `agent ${name}`, run: () => ctx.agents.delete(name, { purge: true }) });

  if (plan.soul !== null) await ctx.agents.docs.put(name, 'SOUL.md', plan.soul);
  for (const doc of plan.docs) await ctx.agents.docs.put(name, doc.name, doc.content);
  if (plan.avatar) await ctx.agents.setAvatar(name, plan.avatar);

  const ruleIds: number[] = [];
  for (const memory of plan.memories) {
    try {
      const rule = await ctx.memory.rules.add({ text: memory.text, scope: 'agent', agent: name, kind: memory.kind });
      ruleIds.push(rule.id);
      undo.push({ what: `rule ${rule.id}`, run: () => ctx.memory.rules.rm(rule.id) });
    } catch (err) {
      // The same rule is already there (a re-import): nothing to add.
      if (codeOf(err) !== 'conflict') throw err;
    }
  }

  const triggerIds: string[] = [];
  for (const routine of plan.routines) {
    const input = (enabled: boolean) => ({
      source: 'schedule' as const,
      name: `${name}: ${routine.name}`.slice(0, 120),
      enabled,
      config: { cron: routine.cron, ...(routine.tz ? { tz: routine.tz } : {}) },
      actions: [{ type: 'task' as const, agent: name, prompt: routine.instruction, title: routine.name, raw: true }],
    });
    let created;
    try {
      created = await ctx.triggers.create(input(routine.enabled));
    } catch (err) {
      // An enabled routine starts tasks with nobody in front: refused until the
      // operator approves the plugin to spawn. It is kept, switched off.
      if (!routine.enabled || codeOf(err) !== 'forbidden') throw err;
      created = await ctx.triggers.create(input(false));
      warnings.push(`Routine "${routine.name}" is imported switched off: this plugin is not approved to start tasks on its own.`);
    }
    const id = created.trigger.id;
    triggerIds.push(id);
    undo.push({ what: `trigger ${id}`, run: () => ctx.triggers.remove(id) });
  }

  const previous = plan.record;
  let teamId: string | null = null;
  if (plan.team) {
    teamId = plan.team.existingId ?? teams.get(plan.team.groupKey) ?? null;
    if (!teamId) {
      // Made last, once the rest of the agent is in place, and reused by the
      // next members. Undone after the agent (first in the list, run last), so
      // the team is empty again by then.
      const made = (await ctx.agents.teams.create({ name: plan.team.name, color: plan.team.color })).id;
      teamId = made;
      teams.set(plan.team.groupKey, made);
      const groupKey = plan.team.groupKey;
      undo.unshift({
        what: `team ${plan.team.name}`,
        run: async () => { teams.delete(groupKey); await ctx.agents.teams.delete(made); },
      });
    }
    if (!creating && previous?.team !== undefined) {
      const before = previous.team;
      undo.push({ what: `team of ${name}`, run: () => ctx.agents.update(name, { team: before }) });
    }
    await ctx.agents.update(name, { team: teamId });
  }

  const docs: Record<string, string | null> = {};
  for (const file of FINGERPRINTED_DOCS) docs[file] = fingerprint(await ctx.agents.docs.get(name, file));
  const record: ImportRecord = {
    sourceApp,
    sourceRef: plan.source.sourceRef,
    // A superadmin's update leaves the record to the account that owns it.
    ownerUserId: previous && previous.ownerUserId !== undefined ? previous.ownerUserId : plan.ownerUserId,
    agent: name,
    docs,
    skills: plan.selected.skills ? skillIds : previous?.skills ?? [],
    mcpServers: plan.selected.mcp ? serverIds : previous?.mcpServers ?? [],
    triggers: plan.selected.routines ? triggerIds : previous?.triggers ?? [],
    rules: [...new Set([...(previous?.rules ?? []), ...ruleIds])],
    team: plan.team ? teamId : previous?.team ?? null,
    touched: false,
    importedAt: Date.now(),
  };
  await records.put(record, plan.recordKey);

  // Routines of the previous import are replaced, once the record names the
  // new ones: removed earlier, a failure of the record would leave the agent
  // with none at all.
  if (previous && plan.selected.routines) {
    for (const id of previous.triggers) {
      try { await ctx.triggers.remove(id); } catch (err) {
        ctx.log.warn(`previous trigger ${id} could not be removed:`, errorText(err));
        warnings.push('A routine of the previous import could not be removed: check the triggers of this agent.');
      }
    }
  }
}
