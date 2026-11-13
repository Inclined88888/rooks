/**
 * Frozen map: native settings group → graft slot.
 *
 * Never derive a slug from the group name. `LLM fallback` would become
 * `llm-fallback`, and hyphens are illegal in slot names
 * (`^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$`). This table is the source;
 * `settings.section` is not in it — that slot is the plugin's own
 * category (keyed by plugin id), not a graft into a native group.
 *
 * `Push` is not a `group` in `orchestrator/src/settings.ts`: the toggle
 * lives on `/settings` as its own section. Same table so a plugin can
 * still graft there once the page paints `settings.notifications`.
 */
export const SETTINGS_GROUP_TO_SLOT: Readonly<Record<string, string>> = Object.freeze({
  Missions: 'settings.missions',
  'LLM fallback': 'settings.llmfallback',
  Resources: 'settings.resources',
  Reaper: 'settings.reaper',
  Worktrees: 'settings.worktrees',
  Permissions: 'settings.permissions',
  Wake: 'settings.wake',
  'Memory — injection': 'settings.memoryinjection',
  'Memory — capture': 'settings.memorycapture',
  'Memory — synthesis': 'settings.memorysynthesis',
  'Memory — promotion': 'settings.memorypromotion',
  'Global digest': 'settings.digest',
  Scoring: 'settings.scoring',
  Dreaming: 'settings.dreaming',
  Terminal: 'settings.terminal',
  Misc: 'settings.misc',
  Infra: 'settings.infra',
  Backlog: 'settings.backlog',
  Voice: 'settings.voice',
  Backup: 'settings.backup',
  'Agent trash': 'settings.agenttrash',
  Push: 'settings.notifications',
});

const SETTINGS_SLOT_TO_GROUP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SETTINGS_GROUP_TO_SLOT).map(([group, slot]) => [slot, group]),
  ),
);

/** List slots declared at boot so a client half can register before `/settings` is on screen. */
export const SETTINGS_GRAFT_SLOTS: Readonly<Record<string, 'list'>> = Object.freeze(
  Object.fromEntries(
    Object.values(SETTINGS_GROUP_TO_SLOT).map((slot) => [slot, 'list' as const]),
  ),
);

export function settingsSlotForGroup(group: string): string {
  const slot = SETTINGS_GROUP_TO_SLOT[group];
  if (slot === undefined) {
    throw new Error(
      `Unknown settings group ${JSON.stringify(group)}: no graft slot (do not slugify)`,
    );
  }
  return slot;
}

export function settingsGroupForSlot(slot: string): string {
  const group = SETTINGS_SLOT_TO_GROUP[slot];
  if (group === undefined) {
    throw new Error(`Unknown settings graft slot ${JSON.stringify(slot)}`);
  }
  return group;
}
