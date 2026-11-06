/**
 * `host` service — the platform adapter shared by the modules.
 *
 * The adapter is built only once, by `boot.ts`, from the
 * resolved configuration (§3.5). This plugin only publishes it under `ctx.host`
 * so that modules get it through `inject: ['host']` rather than through the
 * `getHost()` singleton: a module that injects it is guaranteed that the host
 * exists before its `apply()`, and the day we want a remote host (VPS,
 * §P4) it will be enough to provide another object here.
 *
 * The singleton is still set by `createHost`: the files outside a plugin
 * (`agent.ts`, `resources.ts`, `git.ts`…) have no Cordis context at
 * hand and keep going through it. Both paths return the SAME object.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Host } from '../host/index.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    host: Host;
  }
}

export const name = 'timon-host';

/** Plugin `core-host` : publie l'adaptateur construit par `boot.ts`. */
export function createHostPlugin(host: Host) {
  return {
    name,
    apply(ctx: Context) {
      ctx.provide('host', host);
    },
  };
}
