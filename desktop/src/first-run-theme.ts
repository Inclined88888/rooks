import type { THEME } from './data-update.js';
import type { Scheme } from './appearance.js';

type Palette = { [K in keyof typeof THEME]: string };

/**
 * The palette of the onboarding a fresh install opens on: the Rooks theme,
 * the default of every account made from 0.1.7 on, which the app's floor
 * paints before any account exists. Source of truth:
 * `plugins/theme-rooks/lib/client.js` (HSL tokens, converted to hex here
 * because the window background takes no `hsl()` with spaces);
 * `first-run-theme.test.ts` fails when the two drift apart.
 *
 * Only the first launch uses it: the waiting page and the window must look like
 * the onboarding that follows, not like the product palette of `THEME`.
 */
export const FIRST_RUN_THEME: Record<Scheme, Palette> = {
  dark: {
    background: '#1a171f', // --surface-0 266 15% 10.5%
    foreground: '#f7efe7', // --foreground 30 50% 93.7%
    muted: '#bcaca4', // --muted-foreground 20 15% 69%
    border: '#413b48', // --border 268 10% 25.5%
    chip: '#2f2a34', // --surface-chip (--surface-3) 271 11% 18.5%
    primary: '#f9bb91', // --primary 24 90% 77.3%
    primaryForeground: '#1a171f', // --primary-foreground 266 15% 10.5%
  },
  light: {
    background: '#f6f0e9', // --surface-0 32 42% 93.9%
    foreground: '#1e1618', // --foreground 345 15% 10.2%
    muted: '#6b5a54', // --muted-foreground 16 12% 37.5%
    border: '#dccbbb', // --border 29 32% 79.8%
    chip: '#efe7de', // --surface-chip (--surface-2) 32 35% 90.4%
    primary: '#b4683f', // --primary 21 48% 47.8%
    primaryForeground: '#fcf9f5', // --primary-foreground 30 60% 97.5%
  },
};
