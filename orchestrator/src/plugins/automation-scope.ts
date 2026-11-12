/**
 * What the automation facades (`ctx.routines`, `ctx.triggers`, `ctx.pipelines`,
 * `ctx.workflows`) share: one error type with a typed `code`, and who sees and
 * who may change what.
 *
 * A plugin OWNS what it creates: the row's owner is `plugin:<id>`, in a
 * request as in a job. It reads what the caller sees plus what it owns, and
 * changes only what it owns. An object outside that view answers exactly like
 * one that does not exist.
 */
import { PLUGIN_OWNER_PREFIX } from '../users/api-tokens.js';
import type { DbViewer } from '../users/owned.js';

import type { PluginAutomationErrorCode } from './contract/automation.js';
export type { PluginAutomationErrorCode } from './contract/automation.js';

export class PluginAutomationError extends Error {
  constructor(readonly code: PluginAutomationErrorCode, message: string) {
    super(message);
    this.name = 'PluginAutomationError';
  }
}

export type AutomationCaller = {
  pluginId: string;
  /** The caller of this request, `null` in a job (the plugin acts as itself). */
  viewer: DbViewer | null;
  /** No request: the plugin acts as `plugin:<id>`. */
  job: boolean;
  /** A superadmin's request. Never true in a job. */
  superadmin: boolean;
  /** The permissions the manifest declares: they cap what a stored automation may do later. */
  declared: readonly string[];
};

export const pluginOwnerOf = (pluginId: string): string => `${PLUGIN_OWNER_PREFIX}${pluginId}`;

export const ownedByPlugin = (caller: Pick<AutomationCaller, 'pluginId'>, owner: string | null): boolean =>
  owner !== null && owner === pluginOwnerOf(caller.pluginId);

/** Inside the view of this caller: its own objects, and what the account sees. */
export function visibleTo(caller: AutomationCaller, owner: string | null): boolean {
  if (ownedByPlugin(caller, owner)) return true;
  if (caller.job) return false;
  if (caller.superadmin) return true;
  return owner !== null && owner === caller.viewer?.id;
}
