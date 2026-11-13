/**
 * Which bundled modules the kernel is actually running, for the code that lives
 * OUTSIDE the modules.
 *
 * A module's own routes and jobs disappear with its fiber — that is the loader's
 * job and it needs nothing from here. But some paths sit on the daemon's core
 * (an agent spawn, a plugin context) and still have to ask "is that module on?".
 * Reading `kernel/capabilities.ts` from there would drag the config, the host
 * adapter and the licence into modules that need one boolean, and would risk an
 * import cycle with `secrets/`. Hence this leaf: no import, one set, posted by
 * the same call that posts the live decisions (`setLiveDecisions`), so a hot
 * toggle moves it too.
 *
 * Unset means "everything is on": the CLI, the tests and any code that never
 * boots the kernel must keep the behaviour they had before this file existed.
 */
let active: ReadonlySet<string> | null = null;

/** Posted by `setLiveDecisions`, at boot and on every hot recomposition. */
export function setActiveModules(ids: Iterable<string>): void {
  active = new Set(ids);
}

export function moduleActive(id: string): boolean {
  return active === null || active.has(id);
}

/** Tests only: back to "no kernel has spoken". */
export function resetActiveModules(): void {
  active = null;
}
