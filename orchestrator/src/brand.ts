/**
 * Brand — the source of truth for everything named PUBLICLY.
 *
 * The maintainer's decision of 29/08/2026: the product is called **Timon** (a reference to
 * The Lion King, meerkat mascot), domain `timon-ai.com`, npm scope `@timon-ai`.
 * Phase R (29/08 evening): the internal identifier follows the brand. Home `~/.timon`,
 * `TIMON_*` keys, `timon` binary. The old internal identifier is no longer used
 * in this repo — except in dual-home guards that still name the daily daemon.
 *
 * ## What may use what
 *
 * | Use | Field |
 * |---|---|
 * | Page title, header, interface text, image alt | `displayName` |
 * | Home `~/.timon`, `TIMON_*` keys, CLI binary | `id` / `cliName` |
 * | Published npm packages (SDK, official plugins) | `npmScope`, `sdkPackage` |
 * | Manifest field in a third-party plugin's `package.json` | `manifestKey` |
 *
 * The front has its own copy (`app/src/lib/brand.ts`): the two packages are
 * independent and share no code. Any change here must be carried over
 * there — it is written on both sides.
 */

export type Brand = {
  /** Name shown to a human. Never used as a key, path or identifier. */
  displayName: string;
  /** Product identifier: home `~/.${id}`, `TIMON_*` env keys. */
  id: string;
  /** Name of the public CLI binary. */
  cliName: string;
  /** Public domain of the product. */
  domain: string;
  /** npm scope under which the SDK and the official plugins are published. */
  npmScope: string;
  /** npm package of the third-party plugin SDK (types only). */
  sdkPackage: string;
  /**
   * Manifest key in a third-party plugin's `package.json`. It is a
   * PUBLIC contract: once a plugin is published with this field,
   * changing it breaks every plugin already distributed. Frozen with Phase P.
   */
  manifestKey: string;
  /** Mascot — used for visuals and documentation. */
  mascot: string;
};

export const BRAND: Readonly<Brand> = Object.freeze({
  displayName: 'Timon',
  id: 'timon',
  cliName: 'timon',
  domain: 'timon-ai.com',
  npmScope: '@timon-ai',
  sdkPackage: '@timon-ai/sdk',
  manifestKey: 'timon',
  mascot: 'suricate',
});
