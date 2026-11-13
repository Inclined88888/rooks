import type { MetadataRoute } from 'next';
import { instanceIdentity } from '@/lib/instance';

/**
 * The manifest is what an INSTALLED PWA remembers: its home-screen label and
 * its icon. The maintainer runs two instances, so this is the file that keeps them apart
 * once installed — they already sit on distinct origins (distinct ports), so
 * each gets its own installation; only the name and the artwork were shared.
 */
export const dynamic = 'force-dynamic';

/**
 * Web App Manifest — exposes the Next.js app as an installable PWA.
 * Served at /manifest.webmanifest by the App Router file convention.
 * `display: 'standalone'` strips the browser chrome once installed so it
 * feels like a native app on the home screen.
 *
 * `force-dynamic` above is load-bearing, not a habit: without it Next renders
 * this route AT BUILD TIME, and the build that ships in the Electron package
 * is produced on the development machine — the release would advertise itself
 * as the development instance, permanently, on every user's home screen.
 */
export default function manifest(): MetadataRoute.Manifest {
  const instance = instanceIdentity();
  return {
    name: instance.fullName,
    short_name: instance.shortName,
    description: 'Local-first agent workspace',
    start_url: '/agents',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0a0a',
    // theme_color is omitted on purpose: ThemeColorSync writes
    // <meta name="theme-color"> from `--primary` at runtime so a third-party
    // theme rethemes the URL bar. A baked hex here would win on install and
    // ignore the occupant of the theme slot.
    icons: [
      { src: instance.icons.small, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: instance.icons.large, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: instance.icons.vector, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
