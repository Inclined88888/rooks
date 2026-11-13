/**
 * `ctx.projects` (API 10): a plugin lists, registers and edits Rooks projects,
 * their workspaces (poles) and the agent that holds each task role.
 *
 * Who acts is decided by `context.ts` before this module is reached: a request
 * of an account holding `projects:read` / `projects:manage`, or a job, which
 * acts as `plugin:<id>`. An anonymous request never gets here. This module then
 * applies what `POST /api/projects`, `PUT /api/projects/:slug/meta` and
 * `PATCH /api/projects/:slug/roles/:role` apply, through the same functions
 * (`project-service.ts`), plus rules of its own:
 *
 *  - a plugin EDITS (metadata, roles) only the projects it registered
 *    (`projects.created_by`), unless the caller of the request is a superadmin.
 *    Reading is open to every authenticated caller, as the project list is;
 *  - the working directory is never taken on trust: a path the daemon cannot
 *    `stat` is refused (the warn-only path is a superadmin's), and the `cwd` of
 *    a registered project is not moved from here. A JOB sets none at all: the
 *    cwd of a project widens the roots a non-superadmin's agent may work in
 *    (`projectRoots`, secu-4), so a plugin registering `/` and then creating an
 *    agent there would grant itself any directory with no human in the loop;
 *  - the workspace named in a write must already exist unless `createWorkspace`
 *    is passed, so a typo cannot spawn a second pole;
 *  - a role pin cannot carry more than its writer may hold: backend, model and
 *    permission mode go through the rules that bind a non-superadmin's agents
 *    (`agentConfigRefusal`), jobs included. `force` and `mcp_servers` are not
 *    exposed;
 *  - the working directory is shown only to a caller that may manage projects.
 *
 * The `created_by` mark is written here and nowhere else: no body field reaches it.
 */
import type { ProjectEventOrigin } from '../bus.js';
import { dbApi, type ProjectRow } from '../db.js';
import {
  createProjectFromBody, ProjectServiceError, setProjectRoleFromInput, TASK_ROLES, updateProjectFromBody,
  type CwdWarning,
} from '../project-service.js';
import { listProjects, projectIcon, readRoles, type RoleSpec } from '../projects.js';
import { agentConfigRefusal, RESTRICTED } from '../users/privileged-overrides.js';
import { listWorkspaceRecords } from '../workspaces.js';

import type {
  PluginProject, PluginWorkspace, PluginProjectInput, PluginProjectPatch, PluginProjectWarning,
  PluginProjectWrite, PluginRoleSpec, PluginRoleInput, PluginProjectRoles, PluginProjectErrorCode,
} from './contract/projects.js';
export type {
  PluginProject, PluginWorkspace, PluginProjectInput, PluginProjectPatch, PluginProjectWarning,
  PluginProjectWrite, PluginRoleSpec, PluginRoleInput, PluginProjectRoles, PluginProjectErrorCode,
} from './contract/projects.js';

export class PluginProjectError extends Error {
  constructor(readonly code: PluginProjectErrorCode, message: string) {
    super(message);
    this.name = 'PluginProjectError';
  }
}

export type ProjectCallerScope = {
  pluginId: string;
  /** No request: the plugin acts as itself and edits only its own projects. */
  job: boolean;
  /** The request's caller is a superadmin: ownership and the cwd refusals are lifted. */
  superadmin: boolean;
  /** The plugin declared `projects:manage` and the caller may use it: the working directory is shown. */
  manage: boolean;
};

export type ScopedProjects = {
  list(): PluginProject[];
  get(slug: string): PluginProject | undefined;
  create(input: PluginProjectInput): PluginProjectWrite;
  update(slug: string, patch: PluginProjectPatch): PluginProjectWrite;
  workspaces(): PluginWorkspace[];
  roles(slug: string): PluginProjectRoles;
  setRole(slug: string, role: string, spec: PluginRoleInput | null): PluginProjectRoles;
};

const KEY_OF_PATCH = ['name', 'color', 'icon', 'workspace', 'cwd', 'speech', 'kind', 'status'] as const;

/** A project row as plugin `pluginId` sees it; `cwd` only when `manage`. */
export function projectView(row: ProjectRow, pluginId: string, manage: boolean): PluginProject {
  return {
    slug: row.slug,
    name: row.name,
    color: row.color,
    icon: projectIcon(row.icon),
    workspace: row.workspace,
    cwd: manage ? row.cwd : null,
    speech: row.speech,
    kind: row.kind,
    status: row.status,
    lastActivity: row.last_activity,
    createdBy: row.created_by,
    mine: row.created_by === `plugin:${pluginId}`,
  };
}

export function projectsFor(scope: ProjectCallerScope): ScopedProjects {
  const origin = `plugin:${scope.pluginId}`;
  const eventOrigin: ProjectEventOrigin = Object.freeze({ kind: 'plugin', id: scope.pluginId });

  const view = (row: ProjectRow): PluginProject => projectView(row, scope.pluginId, scope.manage);

  /** Maps the shared operations' typed refusals to this facade's own. */
  const guard = <T>(fn: () => T): T => {
    try { return fn(); } catch (err) {
      if (err instanceof ProjectServiceError) throw new PluginProjectError(err.code, err.message);
      throw err;
    }
  };

  const warningsOf = (list: CwdWarning[]): PluginProjectWarning[] =>
    list.map((w) => ({ field: w.field, code: w.code, path: w.path, message: w.message }));

  /** The row of a project this caller may edit; anything else answers `not_found` / `forbidden`. */
  const editable = (slug: unknown): ProjectRow => {
    const row = typeof slug === 'string' ? dbApi.getProjectRow(slug) : undefined;
    if (!row) throw new PluginProjectError('not_found', `project not found: ${String(slug)}`);
    if (!scope.superadmin && row.created_by !== origin) {
      throw new PluginProjectError('forbidden', `project ${row.slug} was not registered by this plugin`);
    }
    return row;
  };

  const roleSpecView = (spec: RoleSpec): PluginRoleSpec => ({
    agent: spec.agent,
    ...(spec.backend ? { backend: spec.backend } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.permission_mode ? { permissionMode: spec.permission_mode } : {}),
  });

  const rolesView = (slug: string): PluginProjectRoles => {
    const roles = readRoles(slug);
    return Object.fromEntries(
      TASK_ROLES.filter((r) => roles[r]).map((r) => [r, roleSpecView(roles[r]!)]),
    ) as PluginProjectRoles;
  };

  /** Body of the shared operations from a plugin input: the plugin's camelCase to the route's snake_case. */
  const bodyOf = (fields: Record<string, unknown>, createWorkspace: boolean | undefined): Record<string, unknown> => {
    const body: Record<string, unknown> = { workspace_policy: createWorkspace === true ? 'create' : 'existing' };
    for (const key of KEY_OF_PATCH) if (fields[key] !== undefined) body[key] = fields[key];
    return body;
  };

  const known = (input: unknown, allowed: readonly string[], what: string): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PluginProjectError('invalid', `${what} must be an object`);
    const extra = Object.keys(input).filter((k) => !allowed.includes(k));
    if (extra.length) throw new PluginProjectError('invalid', `${what}: unknown field ${extra[0]}`);
    return input as Record<string, unknown>;
  };

  const jobCwdRefusal = (fields: Record<string, unknown>): void => {
    if (scope.job && fields.cwd !== undefined) {
      throw new PluginProjectError('forbidden', 'a background job cannot set a working directory: it widens the directories agents may use, which needs a person behind the request');
    }
  };

  return {
    list() {
      return dbApi.listProjectRows().map(view);
    },

    get(slug) {
      const row = typeof slug === 'string' ? dbApi.getProjectRow(slug) : undefined;
      return row ? view(row) : undefined;
    },

    create(input) {
      const fields = known(input, [...KEY_OF_PATCH, 'slug', 'createWorkspace'], 'project');
      jobCwdRefusal(fields);
      const { project, warnings } = guard(() => createProjectFromBody(
        { ...bodyOf(fields, fields.createWorkspace as boolean | undefined), slug: fields.slug },
        { privileged: scope.superadmin, origin: eventOrigin, createdBy: origin },
      ));
      return { project: view(dbApi.getProjectRow(project.slug)!), warnings: warningsOf(warnings) };
    },

    update(slug, patch) {
      const row = editable(slug);
      const fields = known(patch, [...KEY_OF_PATCH, 'createWorkspace'], 'patch');
      jobCwdRefusal(fields);
      const { warnings } = guard(() => updateProjectFromBody(
        row.slug,
        bodyOf(fields, fields.createWorkspace as boolean | undefined),
        { privileged: scope.superadmin, origin: eventOrigin, requireExisting: true },
      ));
      return { project: view(dbApi.getProjectRow(row.slug)!), warnings: warningsOf(warnings) };
    },

    workspaces() {
      return listWorkspaceRecords().map((w) => ({
        slug: w.slug, name: w.name, color: w.color, leadAgent: w.lead_agent, projects: [...w.projects],
      }));
    },

    roles(slug) {
      if (typeof slug !== 'string' || !listProjects().includes(slug)) {
        throw new PluginProjectError('not_found', `project not found: ${String(slug)}`);
      }
      return rolesView(slug);
    },

    setRole(slug, role, spec) {
      const row = editable(slug);
      let rawSpec: Record<string, unknown> | null = null;
      if (spec !== null) {
        const fields = known(spec, ['agent', 'backend', 'model', 'permissionMode'], 'role');
        if (typeof fields.agent !== 'string' || !fields.agent.trim()) throw new PluginProjectError('invalid', 'role: agent is required');
        rawSpec = { agent: fields.agent.trim() };
        for (const key of ['backend', 'model'] as const) {
          if (fields[key] !== undefined) {
            if (typeof fields[key] !== 'string' || !fields[key]) throw new PluginProjectError('invalid', `role: ${key} must be a non-empty string`);
            rawSpec[key] = fields[key];
          }
        }
        if (fields.permissionMode !== undefined) {
          if (typeof fields.permissionMode !== 'string' || !fields.permissionMode) throw new PluginProjectError('invalid', 'role: permissionMode must be a non-empty string');
          rawSpec.permission_mode = fields.permissionMode;
        }
        if (!scope.superadmin) {
          // A pin is applied at dispatch over the agent's own config: it may not hold more than its writer.
          const { agent: _agent, ...llm } = rawSpec;
          const refusal = agentConfigRefusal(llm, null, RESTRICTED);
          if (refusal) throw new PluginProjectError('forbidden', refusal);
        }
      }
      return guard(() => {
        setProjectRoleFromInput(row.slug, role, rawSpec, { force: false, origin: eventOrigin });
        return rolesView(row.slug);
      });
    },
  };
}
