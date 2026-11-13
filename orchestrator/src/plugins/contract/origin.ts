/** Who caused a write, as the events a plugin receives carry it (TODO #512). */

// Moved from `write-origin.ts`, which re-exports it (TODO #512, volet 3).
export type WriteOrigin = Readonly<{
  kind: 'user' | 'agent' | 'plugin' | 'system';
  /** User id, agent name or plugin id; `null` for the daemon itself. */
  id: string | null;
}>;

// Moved from `bus.ts`, which re-exports it (TODO #512, volet 3).
/** Who wrote a project: `user` (account id), `agent` (name), `plugin` (id), `system`. */
export type ProjectEventOrigin = Readonly<{ kind: 'user' | 'agent' | 'plugin' | 'system'; id: string | null }>;
