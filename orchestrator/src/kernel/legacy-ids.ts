/**
 * Old module ids → namespaced `@rooks/*` ids (plan §10.14).
 *
 * The rename changes a key the user has already written in their
 * `rooks.config.json` (`"modules": { "grepai": false }`) and that a licence
 * file may name. Without an alias, a perfectly valid config would silently
 * stop disabling anything: the key would become dead,
 * nobody would see it, and the module believed to be off would run.
 *
 * The alias is a read, never a rewrite: the user's file is not
 * touched. A `rooks module disable` writes the current id.
 */

/** Old id → current id. A test locks the values onto the catalogue. */
export const LEGACY_IDS: Readonly<Record<string, string>> = Object.freeze({
  'core-db': '@rooks/db',
  'core-settings': '@rooks/settings',
  'core-http': '@rooks/http',
  'core-plugins': '@rooks/plugins',
  'core-secrets': '@rooks/secrets-vault',
  'ui-layout': '@rooks/ui-layout',
  'core-backends': '@rooks/backends',
  'core-agents': '@rooks/agents',
  'core-missions': '@rooks/missions',
  'core-projects': '@rooks/projects',
  notifications: '@rooks/notifications',
  'web-push': '@rooks/web-push',
  memory: '@rooks/memory',
  kanban: '@rooks/kanban',
  'kanban-code': '@rooks/kanban-code',
  routines: '@rooks/routines',
  dreams: '@rooks/dreams',
  'agent-chat': '@rooks/agent-chat',
  'resources-guard': '@rooks/resources-guard',
  vault: '@rooks/vault',
  grepai: '@rooks/grepai',
  'docker-supervision': '@rooks/docker-supervision',
  'browser-embedded': '@rooks/browser-embedded',
  'terminal-native': '@rooks/terminal-native',
  'terminal-web': '@rooks/terminal-web',
  'orchestrator-self': '@rooks/orchestrator-self',
  'web-app': '@rooks/web-app',
  telegram: '@rooks/telegram',
  whatsapp: '@rooks/whatsapp',

  tts: '@rooks/tts',
  'video-factory': '@rooks/video-factory',
});

/**
 * Removed ids: the module has disappeared from the product, and nothing replaces it.
 *
 * `@rooks/backlog` is the case in point: the "TO DO" notebook merged into
 * `@rooks/kanban` (volet 2/4 of the Kanban work). It is NOT aliased to it: a
 * config carrying `"@rooks/backlog": false` asked to switch off the notebook,
 * and translating it into `"@rooks/kanban": false` would switch off the whole
 * board, a feature the user never targeted. A removed id therefore points to
 * nothing: it stays readable without being a silent dead key (`rooks module
 * list` can name it as removed), and the planner ignores it as it ignores any
 * id it does not know.
 */
export const RETIRED_IDS: ReadonlySet<string> = new Set([
  '@rooks/backlog',
  // The Google agenda left the public product until it is finished (06/11/2026,
  // tag `agenda-before-removal`). A config that had it on keeps loading: the key
  // names nothing, and nothing else is switched on or off in its place.
  'agenda',
  '@rooks/agenda',
  'google-calendar',
  '@rooks/google-calendar',
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
 * both `grepai` (legacy) and `@rooks/grepai` (written since) must obey the
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
