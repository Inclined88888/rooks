import { BRAND } from '@/lib/brand';

/**
 * Instance variant — which copy of Rooks this server process is.
 *
 * The maintainer runs two instances side by side (dual-home, see `docs/DUAL-HOME.md`):
 * the daily one and the development one. Same brand, same code, two windows
 * that look alike — and a PWA installed from each shows the same name and the
 * same icon on the home screen. This module is what tells them apart.
 *
 * ## Why the environment, and only at runtime
 *
 * The Electron package ships `app/.next` ALREADY BUILT
 * (`desktop/electron-builder.yml`, `extraResources`). Anything baked at build
 * time — a `NEXT_PUBLIC_*` variable, a module-scope `metadata` object of a
 * statically rendered route — would travel into the release with the value of
 * the machine that produced the build, which is the development machine. The
 * variant is therefore read from `process.env` by the running server, never
 * compiled in, and never exposed to the client bundle: the client receives the
 * resolved identity through a React context seeded by the root layout.
 *
 * The counterpart of that rule lives in `desktop/src/embedded.ts`, which
 * spawns the app with a copy of its own environment: it deletes `ROOKS_INSTANCE`
 * so that launching the packaged client from a development shell cannot leak
 * the DEV name into a release window.
 */

/** `release` is the product; `dev` is the maintainer's development copy. */
export type InstanceVariant = 'release' | 'dev';

export type InstanceIdentity = {
  variant: InstanceVariant;
  /** Short human-readable name — logotype alt, navigation, aria labels. */
  displayName: string;
  /**
   * Full product name — window title, PWA `name`, onboarding screen.
   *
   * Distinct from the `productName` of `desktop/electron-builder.yml`, which
   * stays `Rooks` by an explicit decision: THAT one names the AppImage, the
   * .deb, the `executableName` and the paths the `afterPack` hook builds on
   * them — spaces and a dash there break packaging. This one is only ever
   * read by a human.
   */
  fullName: string;
  /** Home-screen label; kept short because launchers truncate around 12 chars. */
  shortName: string;
  /** Text of the in-app pill, or null when there is nothing to distinguish. */
  badge: string | null;
  /** PWA and apple-touch artwork, by public path; `vector` is the SVG a browser tab prefers. */
  icons: { small: string; large: string; apple: string; vector: string };
  /** The mark's colour (`BrandLogo`): a CSS value, so a theme can drive it. */
  logo: { color: string };
};

const RELEASE: InstanceIdentity = Object.freeze({
  variant: 'release',
  displayName: BRAND.displayName,
  fullName: `${BRAND.displayName} beta - Agentic Workstation`,
  shortName: BRAND.displayName,
  badge: null,
  icons: { small: '/icon-192.png', large: '/icon-512.png', apple: '/apple-icon-180.png', vector: '/icon.svg' },
  // The theme's primary colour: a theme recolours the mark with the rest.
  logo: { color: 'hsl(var(--primary))' },
});

const DEV: InstanceIdentity = Object.freeze({
  variant: 'dev',
  displayName: `${BRAND.displayName} DEV`,
  fullName: `${BRAND.displayName} beta - Agentic Workstation DEV`,
  shortName: `${BRAND.displayName} DEV`,
  badge: 'DEV',
  icons: { small: '/icon-dev-192.png', large: '/icon-dev-512.png', apple: '/apple-icon-dev-180.png', vector: '/icon-dev.svg' },
  // A fixed amber, whatever the theme: the development window stays recognisable.
  logo: { color: '#f59e0b' },
});

/** The identity every consumer falls back to: a client rendered outside the
 *  provider, a test, a plugin mounting the logotype on its own. Release is the
 *  safe default — an instance that forgets to say it is dev shows the product,
 *  never the other way round. */
export const RELEASE_INSTANCE = RELEASE;

/**
 * Only the exact string `dev` opts in. Anything else — unset, empty, `release`,
 * a typo — resolves to the product identity, so a malformed value degrades
 * towards the release name instead of branding a customer's window "DEV".
 */
export function resolveInstanceVariant(
  env: Record<string, string | undefined> = process.env,
): InstanceVariant {
  return (env.ROOKS_INSTANCE ?? '').trim().toLowerCase() === 'dev' ? 'dev' : 'release';
}

/** Resolved identity for this server process. Server-side only — the value is
 *  handed to the client through `InstanceProvider`, never read from the bundle. */
export function instanceIdentity(
  env: Record<string, string | undefined> = process.env,
): InstanceIdentity {
  return resolveInstanceVariant(env) === 'dev' ? DEV : RELEASE;
}
