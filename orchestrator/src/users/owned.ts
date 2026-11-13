/**
 * Ownership filter for the tables listed in `docs/MULTI-USER.md` §5.
 *
 * The WHERE lives here (and is applied by `dbApi` / `scopedDb`), not in
 * each route: a plugin that opens its own path cannot skip it. NULL
 * `owner_user_id` is a system row, visible only with `:read:all`.
 */
import { grantsAllow } from './permissions.js';

export type DbViewer = {
  id: string;
  isSuperadmin: boolean;
  /** Flattened role grants. Absent / empty + not superadmin = own rows only. */
  permissions?: readonly string[];
};

export const OWNED_TABLES = [
  'missions',
  'tasks',
  'notifications',
  'project_todo',
  'agent_messages',
  'browser_sessions',
  'browser_profiles',
  'memory_proposals',
  'dream_proposals',
  'workflows',
  'workflow_runs',
  'pipelines',
] as const;

export type OwnedTable = (typeof OWNED_TABLES)[number];

/**
 * Tables whose NULL-owner rows are shared system rows, not unattributed
 * history: first-run setup leaves them NULL instead of giving them to the
 * first account. A pipeline seeded at boot (`feature-flow`) is readable and
 * runnable by every account; the predicates live in `pipelines.ts`, never in
 * `rowVisible` / `ownerSql`, which keep NULL to `:read:all` for every table.
 */
export const SHARED_SYSTEM_ROW_TABLES: readonly OwnedTable[] = ['pipelines'];

/** Permission asked for the `:all` scope — the table name is the domain. */
export function ownedReadAllPermission(table: OwnedTable): string {
  return `${table}:read:all`;
}

export function viewerSeesAll(viewer: DbViewer, table: OwnedTable): boolean {
  if (viewer.isSuperadmin) return true;
  return grantsAllow(viewer.permissions ?? [], ownedReadAllPermission(table));
}

/**
 * Missing viewer = historical unscoped read (jobs, dispatcher, empty
 * users table). A scoped viewer without `:all` never sees `owner_user_id
 * NULL`.
 */
export function rowVisible<T extends { owner_user_id: string | null }>(
  row: T | undefined,
  viewer: DbViewer | null | undefined,
  table: OwnedTable,
): T | undefined {
  if (!row) return undefined;
  if (!viewer) return row;
  if (viewerSeesAll(viewer, table)) return row;
  return row.owner_user_id === viewer.id ? row : undefined;
}

/**
 * SQL fragment for a WHERE clause. `1=1` when unscoped / `:all`, so the
 * caller can always AND it with other predicates.
 */
export function ownerSql(
  viewer: DbViewer | null | undefined,
  table: OwnedTable,
  column = 'owner_user_id',
): { sql: string; params: unknown[] } {
  if (!viewer || viewerSeesAll(viewer, table)) return { sql: '1=1', params: [] };
  return { sql: `${column} = ?`, params: [viewer.id] };
}
