/**
 * The backend CLI's session id as the missions menu shows it (TODO #419).
 * A claude session or a codex thread is a uuid: its head is enough to tell two
 * apart at a glance, the full value is what the menu copies.
 */
export function shortSessionId(id: string, keep = 8): string {
  return id.length > keep + 1 ? `${id.slice(0, keep)}…` : id;
}
