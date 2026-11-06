/**
 * The mascot parts the plugins declare (`timon.mascot`, API 15), as the look
 * check reads them (`agent-look.ts`): only a plugin that runs right now counts.
 * A pack switched off, refused or removed adds nothing, so a new write naming
 * one of its parts is refused, while a look already stored keeps it.
 */
import { mascotCatalogOf, type MascotPartCatalog } from '../agent-look.js';
import type { PluginStatus } from './loader.js';

export function mascotPartsOf(statuses: Iterable<Pick<PluginStatus, 'id' | 'state' | 'manifest'>>): MascotPartCatalog {
  const packs: Array<readonly [string, NonNullable<NonNullable<PluginStatus['manifest']>['mascot']>]> = [];
  for (const status of statuses) {
    const declared = status.manifest?.mascot;
    // The manifest id, never the package name: it is the namespace the browser half registers under.
    if (status.state === 'active' && declared && status.manifest) packs.push([status.manifest.id, declared]);
  }
  return mascotCatalogOf(packs);
}
