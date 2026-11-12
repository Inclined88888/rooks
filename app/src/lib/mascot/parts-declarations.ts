/**
 * What each mascot pack's manifest declares (`rooks.mascot`), as the daemon
 * lists it (`GET /api/plugins`, field `mascot`). Recorded by the plugin loader
 * before the browser halves register (`recordMascotDeclarations`).
 *
 * The registry admits a part's drawing only if its plugin declares that id for
 * that field: the daemon accepts exactly those ids in a look, so a part offered
 * by the configurator is never refused at save.
 */
import { MASCOT_PART_TYPES, type MascotPartType } from './parts-contract';

export type MascotPackDeclaration = { label: string | null; parts: Readonly<Record<MascotPartType, ReadonlySet<string>>> };

let declared = new Map<string, MascotPackDeclaration>();

function readDecl(raw: unknown): MascotPackDeclaration['parts'] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const out = {} as Record<MascotPartType, Set<string>>;
  let any = false;
  for (const type of MASCOT_PART_TYPES) {
    const list = (raw as Record<string, unknown>)[type];
    out[type] = new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []);
    if (out[type].size) any = true;
  }
  return any ? out : null;
}

export function recordMascotDeclarations(plugins: ReadonlyArray<{ id: string; label?: string | null; mascot?: unknown }>): void {
  const next = new Map<string, MascotPackDeclaration>();
  for (const plugin of plugins) {
    const parts = readDecl(plugin.mascot);
    if (parts) next.set(plugin.id, { label: typeof plugin.label === 'string' && plugin.label ? plugin.label : null, parts });
  }
  declared = next;
}

/** Whether `pluginId`'s manifest declares `slug` as a part of `type`. */
export function mascotPartDeclared(pluginId: string, type: MascotPartType, slug: string): boolean {
  return declared.get(pluginId)?.parts[type].has(slug) ?? false;
}

/** The name the gallery gives the pack; `null` when its manifest has none. */
export function mascotPackLabel(pluginId: string): string | null {
  return declared.get(pluginId)?.label ?? null;
}

export function resetMascotDeclarationsForTests(): void {
  declared = new Map();
}
