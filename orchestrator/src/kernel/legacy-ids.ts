/**
 * Old module ids → namespaced `@timon/*` ids (plan §10.14).
 *
 * The rename changes a key the user has already written in their
 * `timon.config.json` (`"modules": { "grepai": false }`) and that a licence
 * file may name. Without an alias, a perfectly valid config would silently
 * stop disabling anything: the key would become dead,
 * nobody would see it, and the module believed to be off would run.
 *
 * The alias is a read, never a rewrite: the user's file is not
 * touched. A `timon module disable` writes the current id.
 */

/** Old id → current id. A test locks the values onto the catalogue. */
export const LEGACY_IDS: Readonly<Record<string, string>> = Object.freeze({
  'core-db': '@timon/db',
  'core-settings': '@timon/settings',
  'core-http': '@timon/http',
  'core-plugins': '@timon/plugins',
  'core-secrets': '@timon/secrets-vault',
  'ui-layout': '@timon/ui-layout',
  'core-backends': '@timon/backends',
  'core-agents': '@timon/agents',
  'core-missions': '@timon/missions',
  'core-projects': '@timon/projects',
  notifications: '@timon/notifications',
  'web-push': '@timon/web-push',
  memory: '@timon/memory',
  kanban: '@timon/kanban',
  'kanban-code': '@timon/kanban-code',
  routines: '@timon/routines',
  dreams: '@timon/dreams',
  'agent-chat': '@timon/agent-chat',
  'resources-guard': '@timon/resources-guard',
  vault: '@timon/vault',
  grepai: '@timon/grepai',
  'docker-supervision': '@timon/docker-supervision',
  'browser-embedded': '@timon/browser-embedded',
  'terminal-native': '@timon/terminal-native',
  'terminal-web': '@timon/terminal-web',
  'orchestrator-self': '@timon/orchestrator-self',
  'web-app': '@timon/web-app',
  telegram: '@timon/telegram',
  tts: '@timon/tts',
  'video-factory': '@timon/video-factory',
});

/**
 * Removed ids: the module has disappeared from the product, and nothing replaces it.
 *
 * `@timon/backlog` is the case in point: the "TO DO" notebook merged into
 * `@timon/kanban` (volet 2/4 of the Kanban work). It is NOT aliased to it: a
 * config carrying `"@timon/backlog": false` asked to switch off the notebook,
 * and translating it into `"@timon/kanban": false` would switch off the whole
 * board, a feature the user never targeted. A removed id therefore points to
 * nothing: it stays readable without being a silent dead key (`timon module
 * list` can name it as removed), and the planner ignores it as it ignores any
 * id it does not know.
 */
export const RETIRED_IDS: ReadonlySet<string> = new Set([
  '@timon/backlog',
  // The Google agenda left the public product until it is finished (06/11/2026,
  // tag `agenda-before-removal`). A config that had it on keeps loading: the key
  // names nothing, and nothing else is switched on or off in its place.
  'agenda',
  '@timon/agenda',
  'google-calendar',
  '@timon/google-calendar',
]);

/** True if the id named a module the product no longer ships. */
export function isRetiredModuleId(id: string): boolean {
  return RETIRED_IDS.has(id);
}

/**
 * Current id of a module. An unknown id is returned as is: that is the case of a
 * third-party plugin, which this table does not have to know, and of a removed id,
 * which no longer names anything to translate.
 */
export function canonicalModuleId(id: string): string {
  return LEGACY_IDS[id] ?? id;
}

/**
 * Reindexes a `{ id: value }` table onto the current ids.
 *
 * The current id wins when both forms coexist: a config carrying
 * both `grepai` (legacy) and `@timon/grepai` (written since) must obey the
 * user's latest decision, not the trace of the old one.
 */
export function canonicalizeIds<T>(table: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(table)) {
    const canonical = canonicalModuleId(key);
    if (canonical !== key && Object.prototype.hasOwnProperty.call(table, canonical)) continue;
    out[canonical] = value;
  }
  return out;
}
