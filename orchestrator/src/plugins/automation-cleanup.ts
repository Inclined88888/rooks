/**
 * What happens to the automations a plugin owned when the plugin is removed.
 *
 * A routine or a trigger runs unattended on behalf of its owner. Once the
 * plugin that owned it is gone, nobody answers for it, so removing the plugin
 * SWITCHES THEM OFF; the rows stay, listed by `timon plugin remove`, and a
 * superadmin deletes or re-enables them from the Routines and Triggers pages.
 * Pipelines run only when asked: they are listed, not touched. Disabling the
 * plugin (without removing it) leaves everything as it is.
 */
import { dbApi } from '../db.js';
import { updateRoutine } from '../routines.js';
import { disableTriggerRow, listTriggerRows } from '../triggers/store.js';
import { listPipelines } from '../pipelines.js';
import { pluginOwnerOf } from './automation-scope.js';

export type PluginAutomations = {
  /** Ids of the routines that were enabled and are now off. */
  routines: string[];
  /** Ids of the triggers that were enabled and are now off. */
  triggers: string[];
  /** Ids of the pipelines the plugin defined (left in place). */
  pipelines: string[];
};

export function disablePluginAutomations(pluginId: string): PluginAutomations {
  const owner = pluginOwnerOf(pluginId);
  const routines: string[] = [];
  for (const routine of dbApi.listRoutines()) {
    if (routine.owner_user_id !== owner || routine.enabled !== 1) continue;
    updateRoutine(routine.id, { enabled: false });
    routines.push(routine.id);
  }
  // A routine is also a row of the triggers table: it was handled above.
  const triggers = listTriggerRows()
    .filter((row) => row.owner_user_id === owner && row.created_by !== 'routine' && disableTriggerRow(row.id))
    .map((row) => row.id);
  const pipelines = listPipelines().filter((p) => p.owner_user_id === owner).map((p) => p.id);
  return { routines, triggers, pipelines };
}
