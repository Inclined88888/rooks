/**
 * Brand — front-end copy of `orchestrator/src/brand.ts`.
 *
 * ## Why a copy and not an import
 *
 * `app/` and `orchestrator/` are two independent npm packages, neither
 * depending on the other (plan decision: no monorepo, no workspaces). The
 * front end therefore cannot import the constant; it keeps a copy. The two
 * files must stay aligned — it is written on both sides, and it is the
 * accepted price of having no monorepo.
 *
 * `id` and `cliName` are `timon`: home `~/.timon`, keys `TIMON_*`, CLI
 * binary. `displayName` is what a human reads.
 */

export const BRAND = Object.freeze({
  /** Name shown to a human. Never a key, a path or an identifier. */
  displayName: 'Timon',
  /** Product identifier: paths, env keys, CLI. */
  id: 'timon',
  cliName: 'timon',
  domain: 'timon-ai.com',
});
