import { readPackOffers, type ModelListing } from './desktop-speech';

/**
 * The speech models the installed plugins offer for the built-in engine
 * (`dictation.models`, TODO #584), as the Voice pane shows them before the
 * user adds one. Read from the daemon like any client would: the plugin list,
 * then each active plugin's pack. What is shown here is only a preview: the
 * desktop reads the entry again from the daemon before its native box.
 */

/** A pane lists a handful; past this many plugins, the rest wait for the next opening. */
const MAX_PACK_PLUGINS = 16;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function json(fetchImpl: Fetch, url: string): Promise<unknown> {
  try {
    const response = await fetchImpl(url, { cache: 'no-store' });
    return response.ok ? await response.json() as unknown : null;
  } catch {
    return null;
  }
}

/** The ids of the active plugins that declare a pack; a plugin turned off proposes nothing. */
export function packPluginIds(value: unknown): string[] {
  const plugins = value !== null && typeof value === 'object' ? (value as { plugins?: unknown }).plugins : null;
  if (!Array.isArray(plugins)) return [];
  const ids: string[] = [];
  for (const plugin of plugins) {
    const p = plugin !== null && typeof plugin === 'object' ? plugin as { id?: unknown; state?: unknown; dictation?: unknown } : null;
    const models = p?.dictation !== null && typeof p?.dictation === 'object' ? (p.dictation as { models?: unknown }).models : null;
    if (p?.state === 'active' && typeof p.id === 'string' && PLUGIN_ID.test(p.id) && typeof models === 'string' && models) ids.push(p.id);
  }
  return ids.slice(0, MAX_PACK_PLUGINS);
}

/** Every entry the active plugins offer; a plugin whose pack cannot be read is left out, not the list. */
export async function loadPackOffers(fetchImpl: Fetch = (url, init) => fetch(url, init)): Promise<ModelListing[]> {
  const ids = packPluginIds(await json(fetchImpl, '/api/ui/plugins'));
  const packs = await Promise.all(ids.map(async (id) => readPackOffers(id, await json(fetchImpl, `/api/ui/plugins/${encodeURIComponent(id)}/-/dictation-models`))));
  return packs.flat();
}
