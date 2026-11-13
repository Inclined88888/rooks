/**
 * Brand — the source of truth for everything named PUBLICLY.
 *
 * Rooks takeover (Nov 2026): upstream body rebranded to Rooks. Home `~/.rooks`,
 * `ROOKS_*` keys, `rooks` binary. npm scope `@rooks`.
 *
 * ## What may use what
 *
 * | Use | Field |
 * |---|---|
 * | Page title, header, interface text, image alt | `displayName` |
 * | Home `~/.rooks`, `ROOKS_*` keys, CLI binary | `id` / `cliName` |
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
  /** Product identifier: home `~/.${id}`, `ROOKS_*` env keys. */
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
   * changing it breaks every plugin already distributed.
   */
  manifestKey: string;
  /** Mark — used for visuals and documentation. */
  mascot: string;
};

export const BRAND: Readonly<Brand> = Object.freeze({
  displayName: 'Rooks',
  id: 'rooks',
  cliName: 'rooks',
  domain: 'rooks.local',
  npmScope: '@rooks',
  sdkPackage: '@rooks/sdk',
  manifestKey: 'rooks',
  mascot: 'tower',
});
