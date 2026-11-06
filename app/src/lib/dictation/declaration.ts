/**
 * `PluginPublic.dictation` as the daemon publishes it on `/api/plugins`, read
 * under the manifest's grammars. No i18n and no browser API: the app server
 * reads the same declarations to build the window's Content-Security-Policy
 * (`lib/content-security-policy.ts`).
 */

export type DictationEgress = 'none' | 'daemon' | readonly string[];
export type DictationEngineDecl = { id: string; runtime: 'page' | 'daemon'; egress: DictationEgress };
export type DictationDecl = { engines: readonly DictationEngineDecl[]; models: string | null };

/** Same grammars as the manifest (`orchestrator/src/plugins/manifest.ts`). */
const ENGINE_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const HOST_RE = /^(\*\.)?(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_ENGINES = 8;
const MAX_HOSTS = 8;

function readEgress(value: unknown): DictationEgress | null {
  if (value === 'none' || value === 'daemon') return value;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HOSTS) return null;
  if (!value.every((host): host is string => typeof host === 'string' && HOST_RE.test(host))) return null;
  return new Set(value).size === value.length ? [...value] : null;
}

/**
 * `PluginPublic.dictation` read under a guard: an engine whose entry is out of
 * shape is dropped (it then has no destination), never repaired.
 */
export function readDictationDecl(value: unknown): DictationDecl | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as { engines?: unknown; models?: unknown };
  const engines: DictationEngineDecl[] = [];
  if (Array.isArray(v.engines)) {
    for (const raw of v.engines.slice(0, MAX_ENGINES)) {
      if (raw === null || typeof raw !== 'object') continue;
      const e = raw as { id?: unknown; runtime?: unknown; egress?: unknown };
      const egress = readEgress(e.egress);
      if (typeof e.id !== 'string' || !ENGINE_ID_RE.test(e.id) || (e.runtime !== 'page' && e.runtime !== 'daemon') || !egress) continue;
      if (engines.some((known) => known.id === e.id)) continue;
      engines.push({ id: e.id, runtime: e.runtime, egress });
    }
  }
  return { engines, models: typeof v.models === 'string' ? v.models : null };
}
