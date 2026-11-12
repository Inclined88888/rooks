/**
 * What the administration and system facades of `PluginContext` (API 10) have
 * in common: who is asking, what a refusal looks like, and the audit row an
 * action done through a plugin leaves.
 *
 * `context.ts` decides WHO acts before a facade is reached (manifest
 * permission, anonymous, account right, superadmin) and hands the result over
 * as an `AdminCallerScope`. A facade then applies the rules of the route or
 * tool it fronts, through the same functions. No facade in this family reads
 * the request, a header or an environment variable to learn the caller.
 */
import { z } from 'zod';
import { dbApi, type DbViewer } from '../db.js';

import type { PluginAdminErrorCode } from './contract/admin.js';
export type { PluginAdminErrorCode } from './contract/admin.js';

export class PluginAdminError extends Error {
  constructor(
    readonly code: PluginAdminErrorCode,
    message: string,
    /** A narrower reason when the code is not enough (the broker's denial code). */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'PluginAdminError';
  }
}

export type AdminCallerScope = {
  pluginId: string;
  /** No request: the plugin acts as itself (`plugin:<id>`). */
  job: boolean;
  /** What `scopedDb` sees: the account in a request, `plugin:<id>` (no right at all) in a job. */
  viewer: DbViewer | null;
  /** `viewer.id` of a real account, `null` for a job or the daemon token without a user. */
  userId: string | null;
  /** The request's caller is a superadmin. Never true in a job. */
  superadmin: boolean;
};

export function parseAdminInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    const issue = res.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new PluginAdminError('invalid', `${where}${issue?.message ?? 'invalid input'}`);
  }
  return res.data;
}

/**
 * One audit row for a write made through a plugin. `actor` names the plugin and
 * `userId` the account on whose behalf it ran (`null` in a job), so the log
 * reads "plugin acme did user.disable for Ada", never as if Ada had clicked.
 * Never carries a value: only an action and a target.
 */
export function auditPluginAction(scope: AdminCallerScope, action: string, target: string | null): void {
  dbApi.insertAuditLog({ userId: scope.userId, actor: `plugin:${scope.pluginId}`, action, target, ip: null });
}
