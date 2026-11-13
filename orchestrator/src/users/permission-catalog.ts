/**
 * The permission catalogue (`docs/MULTI-USER.md` §19) — what a role
 * editor offers as checkboxes (`ctx.permissionSource.catalog()`, read by the
 * plugin that serves the accounts).
 *
 * Declared in code, and NOT derived from what roles happen to carry
 * anywhere: a permission nobody has granted
 * yet must still be offerable, and a typo stored once must not become a
 * catalogue entry. Every action listed here is a string some check
 * actually reads — `rejectIfDenied`, `viewerSeesAll`, `ctx.assertPermission`
 * or the surface filter of M.4. Adding a check means adding its line here.
 *
 * Surfaces (`page:`, `nav:`, `widget:`, `theme:`, `layout:`) and `plugin:<id>`
 * depend on what is installed, so they are computed from the gallery rather
 * than frozen in the list.
 *
 * Grouping (M.8g): an action owned by a `core` module (or by no module at
 * all — `notify`, `host:exec`…) stays in the family/domain view the editor
 * always had. An action owned by a module that CAN be switched off carries
 * `pluginId`, so the editor folds it into that one plugin's card instead —
 * one card per feature, not a domain card that would vanish/reappear as the
 * module is toggled. A plugin that is not currently active offers nothing
 * here at all: `surfaceActions`/`pluginPermissions` both filter on `state`.
 */
import type { PluginPublic } from '../plugins/public.js';
import { OWNED_TABLES, ownedReadAllPermission, type OwnedTable } from './owned.js';
import { EXTRA_PAGES, navSlug, shortPluginId } from './surfaces.js';

export type PermissionAction = {
  /** First segment of the string — how the editor groups the checkboxes. */
  domain: string;
  permission: string;
  label: string;
  /** Set only for a switchable module: the editor cards it under the plugin. */
  pluginId?: string;
};

export type PermissionCatalog = {
  actions: PermissionAction[];
  plugins: { id: string; name: string; kind: string[]; tier: string | null }[];
};

function action(permission: string, label: string, pluginId?: string): PermissionAction {
  return { domain: permission.split(':')[0]!, permission, label, ...(pluginId ? { pluginId } : {}) };
}

/** Human label of an owned table, used for its `:read:all` scope. */
const OWNED_LABELS: Record<string, string> = {
  missions: 'missions',
  tasks: 'Kanban tasks',
  notifications: 'notifications',
  project_todo: 'project to-dos',
  agent_messages: 'agent messages',
  browser_sessions: 'browser sessions',
  memory_proposals: 'memory proposals',
  dream_proposals: 'dream proposals',
  pipelines: 'pipelines',
};

/**
 * The module a table's `:read:all` scope belongs to, for the tables owned by
 * a module that can be switched off. `missions`, `project_todo` and
 * `agent_messages` are core kernel tables with no entry here — they stay in
 * the family view.
 */
const OWNED_TABLE_PLUGIN: Partial<Record<OwnedTable, string>> = {
  tasks: '@rooks/kanban',
  notifications: '@rooks/notifications',
  browser_sessions: '@rooks/browser-embedded',
  memory_proposals: '@rooks/memory',
  dream_proposals: '@rooks/dreams',
  pipelines: '@rooks/kanban',
};

/**
 * Actions that exist regardless of what is installed. Order matters: it is
 * the order the editor renders inside a domain.
 */
export const PERMISSION_ACTIONS: readonly PermissionAction[] = [
  action('*', 'Everything (full access)'),
  action('missions:spawn', 'Spawn missions'),
  action('agents:communicate', 'Inter-agent communication (allowed unless explicitly denied)'),
  action('missions:read', 'Read own missions'),
  action('missions:stop', 'Stop own agents and projects (missions, inbox, tasks, triggers)'),
  action('trace:read', 'Read mission traces'),
  // `workflows:run` is the grant a trigger's `workflow` action needs, checked
  // against the trigger's frozen grants (`triggers/schema.ts`). Read/write have
  // no check: workflow routes are owner-scoped, not permission-gated, so those
  // two would be checkboxes that do nothing.
  action('workflows:run', 'Start workflows from a trigger'),
  action('kanban:read', 'Read the Kanban', '@rooks/kanban'),
  action('kanban:write', 'Create and update Kanban tasks', '@rooks/kanban'),
  action('triggers:manage', 'Create, update and delete triggers (schedules, webhooks, events)', '@rooks/triggers'),
  // The grant a trigger's `script` action needs (TODO #421). Never in the
  // mission token cap: an agent does not schedule code on the host.
  action('scripts:run', 'Run scripts on the host from a trigger, without an agent', '@rooks/triggers'),
  ...OWNED_TABLES.map((table) => action(
    ownedReadAllPermission(table),
    `Read every user's ${OWNED_LABELS[table] ?? table}`,
    OWNED_TABLE_PLUGIN[table],
  )),
  action('users:read', 'Read accounts', '@rooks/users'),
  action('users:manage', 'Manage accounts, roles and permissions', '@rooks/users'),
  action('settings', 'Read settings'),
  action('settings:write', 'Write settings'),
  action('plugins:manage', 'Install, enable and disable plugins'),
  action('projects:manage', 'Create, update and delete projects'),
  action('agents:read', 'Read agent configuration, files and memory'),
  action('agents:manage', 'Create, update and delete agents'),
  action('agents:privileged-config', "Choose the backend, permission level, tools and MCP servers of agents, missions and tasks, up to the caller's own level"),
  action('files:external', "Open and edit files outside an agent's folder, from a link in the chat"),
  action('mcp:manage', 'Create, update and delete MCP servers'),
  action('skills:manage', 'Create, update and delete skills'),
  action('secrets:read', 'Read secrets', '@rooks/secrets-vault'),
  action('secrets:manage', 'Create, update and delete secrets', '@rooks/secrets-vault'),
  action('secrets:create', 'Create a new secret from an agent mission (daemon-generated or supplied, daemon-only, never readable back)', '@rooks/secrets-vault'),
  action('secrets:broker', 'Call an API or fetch a git credential under a brokered identity', '@rooks/secrets-vault'),
  action('storage', 'Plugin key-value storage'),
  action('notify', 'Send notifications'),
  action('events:subscribe', 'Subscribe to the event stream'),
  action('http:outbound', 'Outbound HTTP calls'),
  action('host:exec', 'Run host commands'),
  action('terminal:open', 'Open a shell on the host from the built-in terminal (amounts to full control of the machine)', '@rooks/terminal-web'),
];

/**
 * Surface permissions of THIS installation: one `page:` per route (plus its
 * `nav:` slug), one `widget:` / `theme:` / `layout:` per plugin that is one.
 * Read off the live gallery rather than the static `bundled-identity`
 * registry, so a disabled module's surfaces drop out instead of lingering
 * in the catalogue; `EXTRA_PAGES` alone (no plugin owns them) always stay.
 */
export function surfaceActions(plugins: readonly PluginPublic[] = []): PermissionAction[] {
  const out: PermissionAction[] = [];
  const navSeen = new Set<string>();

  const pushPage = (route: string, pluginId?: string) => {
    out.push(action(`page:${route}`, `See the page ${route}`, pluginId));
    const slug = navSlug(route);
    if (!navSeen.has(slug)) {
      navSeen.add(slug);
      out.push(action(`nav:${slug}`, `See the nav entry ${slug}`, pluginId));
    }
  };

  for (const route of EXTRA_PAGES) pushPage(route);

  for (const plugin of plugins) {
    if (plugin.state !== 'active') continue;
    // `core` cannot be switched off — its surfaces stay in the family view,
    // same as an EXTRA_PAGES route (plan §... / M.8g).
    const owner = plugin.tier === 'core' ? undefined : plugin.id;
    if (plugin.route) pushPage(plugin.route, owner);
    const short = shortPluginId(plugin.id);
    const name = plugin.label ?? plugin.id;
    if (plugin.kind.includes('widget')) out.push(action(`widget:${short}`, `See the widget ${name}`, owner));
    if (plugin.kind.includes('theme')) out.push(action(`theme:${short}`, `Use the theme ${name}`, owner));
    if (plugin.kind.includes('layout')) out.push(action(`layout:${short}`, `Use the layout ${name}`, owner));
  }
  return out;
}

/**
 * `plugin:<id>` is the single switch of a third-party package: without it
 * every `/api/plugins/<id>/*` route is closed (M.4 / M.7). Bundled modules
 * are listed too — they can also be opened by the surface they declare.
 * Inactive plugins offer nothing here: a disabled module must not appear
 * in the catalogue at all.
 */
export function pluginPermissions(
  plugins: readonly PluginPublic[] = [],
): PermissionCatalog['plugins'] {
  return plugins
    .filter((plugin) => plugin.state === 'active')
    .map((plugin) => ({
      id: plugin.id,
      name: plugin.label ?? plugin.id,
      kind: [...plugin.kind],
      tier: plugin.tier,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function permissionCatalog(plugins: readonly PluginPublic[] = []): PermissionCatalog {
  const activeIds = new Set(
    plugins.filter((plugin) => plugin.state === 'active').map((plugin) => plugin.id),
  );
  const seen = new Set<string>();
  const actions: PermissionAction[] = [];
  for (const entry of [...PERMISSION_ACTIONS, ...surfaceActions(plugins)]) {
    // A plugin-owned action whose plugin isn't active right now: drop it,
    // same rule as `pluginPermissions` — a disabled module is invisible here.
    if (entry.pluginId && !activeIds.has(entry.pluginId)) continue;
    if (seen.has(entry.permission)) continue;
    seen.add(entry.permission);
    actions.push(entry);
  }
  return { actions, plugins: pluginPermissions(plugins) };
}
