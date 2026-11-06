/**
 * `ctx.memory`: a plugin writes, lists and removes memory rules, searches the
 * memory and reads the memory files of an agent or a project — the logic of
 * the `memory_*` MCP tools, within the rights of the account that acts.
 *
 * Who acts is decided by `context.ts` before this module is reached: a request
 * of an account holding the rights below, or a job, which acts as
 * `plugin:<id>`. An anonymous request never gets here. Then:
 *
 *  - a rule a plugin writes carries `source: plugin:<id>` (`memory-rule-origin.ts`),
 *    set HERE and refused from any payload. A plugin REMOVES only the rules it
 *    wrote, unless the caller of the request is a superadmin;
 *  - a JOB sees only what its plugin wrote: its rules in `rules.list` and
 *    `search`, its agents' memory files in `show`. Another's rule answers like
 *    a missing one;
 *  - a rule reaches the prompt of every agent in its scope. A job writes to
 *    the agents its plugin created only; a request may target any existing
 *    agent, project or role; `scope: 'global'` and `tier: 'core'` (injected
 *    everywhere, always) need a superadmin caller;
 *  - search and `show` read agent memory, which is secret-bearing
 *    (SECURITY.md §6.5): in a request they need the account to hold
 *    `agents:read` or `agents:manage`, as the memory routes do.
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { canonicalAgentName, loadConfig } from '../agent-config.js';
import { getRole } from '../agent-roles.js';
import { dbApi, type DbViewer, type MemoryRuleRow } from '../db.js';
import { deleteMemoryRule, memoryOverview, searchMemoryHits } from '../memory-queries.js';
import { MemoryRuleError, RULE_KINDS, RULE_SCOPES, addMemoryRule } from '../memory-rule-add.js';
import { pluginRuleOrigin } from '../memory-rule-origin.js';
import { agentDir } from '../paths.js';

import type {
  PluginMemoryRule, PluginMemoryRuleInput, PluginMemoryRuleFilter, PluginMemoryFileInfo,
  PluginMemoryFile, PluginMemoryTargetScope, PluginMemoryOverview, PluginMemorySearchResult,
  PluginMemoryErrorCode,
} from './contract/memory.js';
export type {
  PluginMemoryRule, PluginMemoryRuleInput, PluginMemoryRuleFilter, PluginMemoryFileInfo,
  PluginMemoryFile, PluginMemoryTargetScope, PluginMemoryOverview, PluginMemorySearchResult,
  PluginMemoryErrorCode,
} from './contract/memory.js';

export class PluginMemoryError extends Error {
  constructor(readonly code: PluginMemoryErrorCode, message: string) {
    super(message);
    this.name = 'PluginMemoryError';
  }
}

export type MemoryCallerScope = {
  pluginId: string;
  /** No request: the plugin acts as itself and sees only what it wrote. */
  job: boolean;
  /** The request's caller is a superadmin: reserved scopes and ownership lifted. */
  superadmin: boolean;
  viewer: DbViewer | null;
};

export type ScopedMemory = {
  rules: {
    add(input: PluginMemoryRuleInput): Promise<PluginMemoryRule>;
    list(filter?: PluginMemoryRuleFilter): Promise<PluginMemoryRule[]>;
    rm(id: number): Promise<PluginMemoryRule>;
  };
  search(query: string): Promise<PluginMemorySearchResult>;
  overview(): Promise<PluginMemoryOverview>;
  show(scope: PluginMemoryTargetScope, id: string): Promise<PluginMemoryFileInfo[]>;
  show(scope: PluginMemoryTargetScope, id: string, file: string): Promise<PluginMemoryFile>;
};

const RuleInputSchema = z.object({
  text: z.string().min(1).max(4000),
  scope: z.enum(RULE_SCOPES).optional(),
  agent: z.string().min(1).max(100).optional(),
  project: z.string().min(1).max(200).optional(),
  role: z.string().min(1).max(32).optional(),
  kind: z.enum(RULE_KINDS).optional(),
  tier: z.enum(['normal', 'core']).optional(),
}).strict();

const FilterSchema = z.object({
  scope: z.enum(RULE_SCOPES).optional(),
  project: z.string().min(1).max(200).optional(),
  agent: z.string().min(1).max(100).optional(),
}).strict();

const QuerySchema = z.string().max(500);
const ShowSchema = z.object({
  scope: z.enum(['agent', 'project']),
  id: z.string().min(1).max(200),
  file: z.string().min(1).max(200).optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    const issue = res.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new PluginMemoryError('invalid', `${where}${issue?.message ?? 'invalid input'}`);
  }
  return res.data;
}

/** The agent's config when it exists and is not ephemeral, else `null`. */
function agentConfigOf(name: string) {
  try {
    const canonical = canonicalAgentName(name);
    if (!existsSync(agentDir(canonical))) return null;
    const cfg = loadConfig(canonical);
    return cfg.ephemeral === true ? null : { name: canonical, createdBy: cfg.created_by ?? null };
  } catch {
    return null;
  }
}

export function memoryFor(scope: MemoryCallerScope): ScopedMemory {
  const origin = pluginRuleOrigin(scope.pluginId);
  const actor = { kind: 'plugin', id: scope.pluginId } as const;

  const view = (r: MemoryRuleRow): PluginMemoryRule => Object.freeze({
    id: r.id, scope: r.scope, project: r.project, agent: r.agent, role: r.role, kind: r.kind, tier: r.tier,
    status: r.status, text: r.text, createdAt: r.created_at, source: r.source, mine: r.source === origin,
  });

  /** The agent an `agent`-scoped file or rule targets, resolved for THIS caller. */
  const agentTarget = (name: string): string => {
    const found = agentConfigOf(name);
    // A job sees only the agents its plugin created: another's answers like a missing one.
    if (!found || (scope.job && found.createdBy !== origin)) throw new PluginMemoryError('not_found', `agent not found: ${name}`);
    return found.name;
  };


  async function show(targetScope: PluginMemoryTargetScope, id: string): Promise<PluginMemoryFileInfo[]>;
  async function show(targetScope: PluginMemoryTargetScope, id: string, file: string): Promise<PluginMemoryFile>;
  async function show(targetScope: PluginMemoryTargetScope, id: string, file?: string): Promise<PluginMemoryFileInfo[] | PluginMemoryFile> {
    const t = parse(ShowSchema, { scope: targetScope, id, file });
    const { listMemory, readMemory } = await import('../agent.js');
    const { listProjectMemory, readProjectMemory } = await import('../projects.js');
    let result: PluginMemoryFileInfo[] | PluginMemoryFile;
    try {
      if (t.scope === 'agent') {
        const name = agentTarget(t.id);
        if (t.file === undefined) result = listMemory(name);
        else {
          const content = readMemory(name, t.file);
          if (content === null) throw new PluginMemoryError('not_found', 'memory file not found');
          result = { name: t.file, content };
        }
      } else {
        // A project has no creator to bound a job by: a job reads none.
        if (scope.job || !dbApi.getProjectRow(t.id)) throw new PluginMemoryError('not_found', `project not found: ${t.id}`);
        if (t.file === undefined) result = listProjectMemory(t.id);
        else {
          const content = readProjectMemory(t.id, t.file);
          if (content === null) throw new PluginMemoryError('not_found', 'memory file not found');
          result = { name: t.file, content };
        }
      }
    } catch (err) {
      if (err instanceof PluginMemoryError) throw err;
      // `validName` / `validMemoryFile` refuse a malformed name with a plain Error.
      throw new PluginMemoryError('invalid', (err as Error).message);
    }
    return result;
  }

  return {
    rules: {
      async add(input) {
        const fields = parse(RuleInputSchema, input);
        const ruleScope = fields.scope ?? 'agent';
        if (!scope.superadmin && (ruleScope === 'global' || fields.tier === 'core')) {
          throw new PluginMemoryError('forbidden', 'only a superadmin may write a global or core rule');
        }
        const body: Parameters<typeof addMemoryRule>[0] = { ...fields, scope: ruleScope };
        if (ruleScope === 'agent') {
          // Required by `addMemoryRule`; checked against this caller's view first.
          if (!fields.agent) throw new PluginMemoryError('invalid', "scope 'agent' needs `agent`");
          body.agent = agentTarget(fields.agent);
        } else if (ruleScope === 'project' || ruleScope === 'role') {
          if (scope.job) throw new PluginMemoryError('forbidden', `a job writes rules to its own agents only, not to a ${ruleScope}`);
          if (ruleScope === 'project' && fields.project && !dbApi.getProjectRow(fields.project)) {
            throw new PluginMemoryError('invalid', `unknown project: ${fields.project}`);
          }
          if (ruleScope === 'role' && fields.role && !getRole(fields.role)) {
            throw new PluginMemoryError('invalid', `unknown role: ${fields.role}`);
          }
        }
        try {
          return view(addMemoryRule(body, { pluginSource: origin, actor }));
        } catch (err) {
          if (err instanceof MemoryRuleError) throw new PluginMemoryError(err.status === 409 ? 'conflict' : 'invalid', err.message);
          throw err;
        }
      },

      async list(filter = {}) {
        const f = parse(FilterSchema, filter);
        const rows = dbApi.listRules({ ...f, ...(scope.job ? { source: origin } : {}) });
        return rows.map(view);
      },

      async rm(id) {
        if (!Number.isInteger(id)) throw new PluginMemoryError('invalid', 'invalid rule id');
        const row = dbApi.getRule(id);
        // A job sees only its own rules: another's answers like a missing one.
        if (!row || (scope.job && row.source !== origin)) throw new PluginMemoryError('not_found', `rule not found: ${id}`);
        if (!scope.superadmin && row.source !== origin) {
          throw new PluginMemoryError('forbidden', `rule ${id} was not written by this plugin`);
        }
        const removed = deleteMemoryRule(id, actor);
        if (!removed) throw new PluginMemoryError('not_found', `rule not found: ${id}`);
        return view(removed);
      },
    },

    async search(query) {
      const q = parse(QuerySchema, query);
      return searchMemoryHits(q, scope.job ? origin : undefined);
    },

    async overview() {
      if (!scope.job) return memoryOverview(scope.viewer);
      // A job counts its own rules; facts, pitfalls and proposals are not its to see.
      const mine = dbApi.listRules({ source: origin }).length;
      return { counts: { facts: 0, pitfalls: 0, rules: mine, pending: 0, projects: 0 }, proposals: [] };
    },

    show,
  };
}
