/**
 * Brand — front-end copy of `orchestrator/src/brand.ts`.
 *
 * `app/` and `orchestrator/` are two independent npm packages. Keep aligned.
 * `id` and `cliName` are `rooks`: home `~/.rooks`, keys `ROOKS_*`, CLI binary.
 */

export const BRAND = Object.freeze({
  /** Name shown to a human. Never a key, a path or an identifier. */
  displayName: 'Rooks',
  /** Product identifier: paths, env keys, CLI. */
  id: 'rooks',
  cliName: 'rooks',
  domain: 'rooks.local',
});
