/**
 * Which plugin holds the account provider (`ctx.accountProvider`), if any. Kept
 * apart from the facade so the core's access rule (`free-access.ts`) can read it
 * without depending on the plugin layer.
 */
let holder: string | null = null;

/** The plugin that holds the account provider, `null` when none. */
export function accountProviderHolder(): string | null {
  return holder;
}

/** Claims the provider for `pluginId`; returns the current holder (the claimant when it succeeded). */
export function claimAccountProvider(pluginId: string): string {
  if (holder === null) holder = pluginId;
  return holder;
}

/** Releases the account provider when its holder is unloaded. */
export function releaseAccountProvider(pluginId: string): void {
  if (holder === pluginId) holder = null;
}
