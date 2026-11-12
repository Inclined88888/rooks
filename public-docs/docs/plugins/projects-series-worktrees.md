---
title: Projects, series and worktrees
sidebar_position: 13.8
---

Your plugin can register and edit Rooks projects, steer the fallback plan and the per-role models of a task series, and manage the git worktree of a task: the same operations the web app, the CLI and an agent's tools perform. Requires `apiVersion: 10`.

```json
"rooks": {
  "id": "acme-sync",
  "apiVersion": 10,
  "permissions": ["projects:manage", "series:manage", "worktrees:manage", "events:subscribe"]
}
```

| Permission | Surface |
| --- | --- |
| `projects:read` | `ctx.projects` `list`, `get`, `workspaces`, `roles`; with `events:subscribe`, the project events |
| `projects:manage` | `create`, `update`, `setRole`, and the working directory in what you read. **Sensitive** |
| `series:read` | `ctx.series.fallback.list`, `ctx.series.role.list` |
| `series:manage` | `ctx.series.fallback.set` / `clear`, `ctx.series.role.set` / `clear`. **Sensitive** |
| `worktrees:read` | `ctx.worktrees.info` |
| `worktrees:manage` | `ctx.worktrees.create` / `dispose`. **Sensitive** |

A `:manage` permission covers reading too. A sensitive permission is named apart when a user installs the plugin. In a request, the calling account needs the same right for `projects:manage` (a plain account can list projects, not write them); anonymous requests are always refused.

## Projects

```js
const { project, warnings } = await ctx.projects.create({
  slug: 'acme-app', name: 'Acme', cwd: '/srv/acme', workspace: 'Design Studio',
});
await ctx.projects.update('acme-app', { speech: 'Customer portal', color: '#3366ff' });
await ctx.projects.workspaces();                         // [{ slug, name, leadAgent, projects }]
await ctx.projects.roles('acme-app');                    // { code: { agent: 'Jean-Pierre' }, … }
await ctx.projects.setRole('acme-app', 'review', { agent: 'Jean-Pierre', model: 'sonnet' });
await ctx.projects.setRole('acme-app', 'review', null);  // clears the pin
```

- **Reads** are open to every authenticated caller, as the project list is. The working directory (`cwd`) is `null` unless your plugin holds `projects:manage` and the caller may use it.
- **Edits** reach only the projects your plugin registered (`createdBy: 'plugin:<id>'`, `mine: true`); another project answers `forbidden`, a missing one `not_found`. A superadmin's request lifts the rule.
- **The working directory** must be an absolute path to an existing directory: anything else is refused (`forbidden` / `invalid`), except for a superadmin, who gets a `warnings` entry instead. The `cwd` of a project that already has one is not moved from here. A background job sets none (`forbidden`): a project's directory widens where agents may work, so it needs a person behind the request.
- **The workspace** (pole) you name must exist, matched ignoring case; pass `createWorkspace: true` to create it on purpose. A typo cannot spawn a second pole.
- **The icon** is an emoji or a short code (32 characters at most), or a picture already uploaded to Rooks (`/api/uploads/projects/…`). A web address is refused (`invalid`): the app only shows pictures it serves. A project whose stored icon breaks this rule reads with `icon: null`.
- **A role pin** cannot hold more than its writer could give an agent: backend, model and `permissionMode` follow the rules that bind a non-superadmin's agents (`bypassPermissions` and sandboxed backends are refused). `force` and MCP lists are not available.
- **Errors** throw `PluginProjectError` with a `code`: `invalid`, `not_found`, `forbidden`.

## Project events

```js
ctx.events.on('project_created', (ev) => { /* ev.slug, ev.project, ev.origin */ });
ctx.events.on('project_updated', (ev) => { /* ev.changed: ['speech'], ev.origin */ });
```

Creating or editing a project fires one — from the app, the CLI, an agent's tool, the demo project or a plugin — with the writer in `origin`: `{ kind: 'user' | 'agent' | 'plugin' | 'system', id }`. A connector that mirrors projects drops the echo of its own writes by comparing `origin` with its id. `changed` lists the fields written (`roles` for a role pin). The event carries the project without its working directory. Delivery is deferred and in order, one handler at a time per plugin; projects belong to no one, so every plugin holding `projects:read` receives every event.

## Series

A series is the pilot mission of a chantier plus the tasks it spawned. Name it by its id or by the id of its pilot mission (`current` does not exist for a plugin).

```js
await ctx.series.fallback.set(seriesId, { scope: 'code', backend: 'claude', model: 'opus' });
await ctx.series.fallback.set(seriesId, { scope: 'orchestrator', backend: null });  // never falls back
await ctx.series.fallback.list(seriesId);
await ctx.series.role.set(seriesId, { scope: 'review', backend: 'claude', model: 'sonnet' });
await ctx.series.role.clear(seriesId, 'review');
// one group of workstreams of the series plan (tasks created with `planGroup: 'complex'`, and their chain)
await ctx.series.role.set(seriesId, { scope: 'code', backend: 'claude', model: 'opus', group: 'complex' });
await ctx.series.fallback.set(seriesId, { scope: 'code', backend: 'codex', model: 'gpt-5.5', group: 'complex' });
await ctx.series.role.clear(seriesId, 'code', 'complex');
```

- **Which series.** In a request, those whose pilot mission or one of whose tasks the calling account can see; in a job, those `plugin:<id>` owns. Any other answers `not_found`.
- **A fallback rule is applied at once** to the pending and blocked tasks of its scope, unless `apply: false`; `applied` tells where they went. The rule is kept even if applying it failed (`applyError`).
- **Groups of workstreams.** `group` (at most 60 characters, no control characters, never with scope `orchestrator`) scopes a rule or a choice to the tasks created with that `planGroup` (`ctx.kanban.add`) and to the review, merge, doc and further coding rounds chained after them. A task reads its group's rule before the series' one, field by field: task override > group > series > project role. Lists return the series-wide rules first (`planGroup: null`), then the groups'. A rule of a group applied at once moves that group's tasks only; `clear(seriesId, scope, group)` removes the group's rule, the two-argument call the series-wide one.
- **Targets.** A backend or model that a non-superadmin's agent could not be given is refused (`forbidden`): a backend that runs in a sandbox (such as `codex`) can only be named by a request from a superadmin, never by a job or an ordinary account.
- **Errors** throw `PluginSeriesError`: `invalid`, `not_found`, `forbidden`.

## Worktrees

```js
await ctx.worktrees.info(taskId);                        // { taskId, path, branch, base, mergedCommitSha }
await ctx.worktrees.create(taskId, { base: 'main' });
await ctx.worktrees.dispose(taskId);
```

Bounded like `ctx.kanban`: a task outside the caller's view answers `not_found` (`undefined` for `info`). `create` refuses a task that already has a worktree or is done — the dispatcher creates one for every code task. `dispose` only takes a task that is **done and merged**, and answers `conflict` otherwise: disposing a live task destroys the coder's uncommitted work. Errors throw `PluginWorktreeError`: `invalid`, `not_found`, `conflict`, `failed`, `module_disabled`.

## See also

- [Permissions](permissions.md)
- [Webhooks](webhooks.md)
- [Rooks tools for a remote agent](remote-mcp.md)
