/** Per-user backdrop settings; image bytes are stored separately on disk. */
export const BACKGROUND_SCOPE = 'appearance.background';
export const BACKGROUND_PATTERNS = ['hexagons', 'grid', 'crosses', 'dots', 'circuit', 'none'] as const;
export type BackgroundPattern = typeof BACKGROUND_PATTERNS[number];
export type BackgroundConfig = {
  mode: 'pattern' | 'photo';
  pattern: BackgroundPattern;
  colors: { light: string | null; dark: string | null };
  intensity: number;
  photo: string | null;
  veil: number;
};
/**
 * A plain canvas, on purpose.
 *
 * The hexagon weave used to be the shipped backdrop, and it is the first
 * thing a new install sees behind everything else — a texture nobody chose,
 * under cards that are themselves frameless and transparent
 * (`widget-host/widget-defaults.ts`). `none` leaves the theme's own surface
 * showing; every pattern stays one click away in the appearance menu.
 *
 * `intensity` keeps a usable value rather than 0: it is what the slider
 * starts from the moment a pattern IS picked, and a zero there would make
 * the first choice look broken.
 */
export const DEFAULT_BACKGROUND: BackgroundConfig = {
  mode: 'pattern', pattern: 'none', colors: { light: null, dark: null }, intensity: 0.3, photo: null, veil: 0.65,
};
const PHOTO_URL = /^\/api\/ui\/appearance\/background-image\/[a-f0-9-]+\.(?:jpg|png|webp|gif)$/;
const bounded = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
export function readBackground(raw: unknown): BackgroundConfig {
  const v = raw && typeof raw === 'object' ? raw as Partial<BackgroundConfig> & { color?: unknown } : {};
  const hex = (value: unknown): string | null => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : null;
  const colors = { light: hex(v.colors?.light), dark: hex(v.colors?.dark) };
  // Legacy single-colour preferences belong to the matching scheme only.
  // A white canvas saved in light mode must never override the dark palette.
  const legacy = hex(v.color);
  if (!v.colors && legacy) {
    const rgb = [1, 3, 5].map(i => parseInt(legacy.slice(i, i + 2), 16) / 255);
    const brightness = rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
    colors[brightness > 0.5 ? 'light' : 'dark'] = legacy;
  }
  const photo = typeof v.photo === 'string' && PHOTO_URL.test(v.photo) ? v.photo : null;
  return {
    mode: v.mode === 'photo' && photo ? 'photo' : 'pattern',
    pattern: BACKGROUND_PATTERNS.includes(v.pattern!) ? v.pattern! : DEFAULT_BACKGROUND.pattern,
    colors,
    intensity: bounded(v.intensity, DEFAULT_BACKGROUND.intensity, 0, 0.65),
    photo,
    veil: bounded(v.veil, DEFAULT_BACKGROUND.veil, 0.1, 0.95),
  };
}
