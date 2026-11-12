/**
 * Mirror tasks: the inert image of a ticket that lives in another system
 * (GitHub Projects, Linear, Jira), kept in the Kanban by a plugin so the board
 * shows it and the plugin can sync both ways (`tasks.mirror`, db.ts).
 *
 * A mirror task is data, not work. Everything that would turn a task into an
 * agent run asks this one predicate first: the dispatcher (never spawns it),
 * the closure chain (no review, merge or doc task after it), the wake loop (no
 * return to a pilot, no "blocked" recap), the blocked alert and the user
 * triggers. A plugin moves its status like any other field; nothing reacts.
 *
 * One predicate rather than one check per consumer, so a consumer added later
 * has a single name to grep for.
 */
export function isMirrorTask(task: { mirror?: number | null } | null | undefined): boolean {
  return task?.mirror === 1;
}
