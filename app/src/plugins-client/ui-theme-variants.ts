import { DEFAULT_GLASS_SCOPE, GLASS_SCOPE_ATTRIBUTE, GLASS_TUNING_ENABLED, readGlassScope, type GlassScope } from '@/lib/glass-scope';

/** Native theme variants. Surfaces stay opaque; the accent and geometry form
 * one deliberately small family shared by every route and plugin. */
export const THEME_VARIANTS = [
  { id: 'coral', name: 'Coral', description: 'Warm · soft corners', dark: '13 67% 67%', light: '12 63% 41%', radius: 10, borderDark: '220 8% 24%', borderLight: '220 10% 83%' },
  { id: 'teal', name: 'Teal', description: 'Precise · subtle borders', dark: '173 51% 58%', light: '174 72% 27%', radius: 8, borderDark: '180 8% 24%', borderLight: '180 9% 82%' },
  { id: 'cobalt', name: 'Cobalt', description: 'Technical · crisp corners', dark: '216 85% 73%', light: '218 74% 43%', radius: 6, borderDark: '218 12% 29%', borderLight: '218 14% 78%' },
  { id: 'iris', name: 'Iris', description: 'Soft · rounded lines', dark: '263 65% 77%', light: '263 48% 43%', radius: 12, borderDark: '260 8% 25%', borderLight: '260 10% 84%' },
  { id: 'graphite', name: 'Graphite', description: 'Monochrome · defined borders', dark: '220 9% 85%', light: '220 12% 28%', radius: 0, borderDark: '220 7% 33%', borderLight: '220 8% 73%' },
] as const;
export type ThemeVariant = typeof THEME_VARIANTS[number]['id'];
export const APPEARANCE_SCOPE = 'appearance.native';
export const APPEARANCE_EVENT = 'rooks:native-theme';
export function readThemeVariant(raw: unknown): ThemeVariant {
  const id = raw && typeof raw === 'object' ? (raw as { variant?: unknown }).variant : raw;
  return THEME_VARIANTS.find((v) => v.id === id)?.id ?? 'teal';
}

/**
 * Everything the native Appearance screen stores in `APPEARANCE_SCOPE`. The row
 * used to hold `{ variant }` alone: every field added since defaults to what
 * that row painted, so an install that never opened the new controls does not
 * change a pixel.
 */
export type NativeAppearance = {
  variant: ThemeVariant;
  /** `#rrggbb` chosen in the colour picker; `null` keeps the variant's accent. */
  primary: string | null;
  /** Frosted widgets, topbar and navigation rail. */
  glass: boolean;
  /** Frosted chat bubbles — only the ones on screen, see `glass-bubbles.ts`. */
  glassBubbles: boolean;
  /** Whole island or each widget (`lib/glass-scope.ts`); an island's menu may override it. */
  glassScope: GlassScope;
  /** The style every widget starts from; one widget's own choice wins over it. */
  widgetsBorderless: boolean;
  widgetsTransparent: boolean;
  /** When either switch last changed (ms; 0 = never). A widget's own choice older than this is overruled. */
  widgetsStyleAt: number;
  /** General glass blur radius in px (`GLASS_BLUR_RANGE`); a zone may set its own (`glassZones`). */
  glassBlur: number;
  /** How much of the background shows through the glass, in % (`GLASS_TRANSPARENCY_RANGE`). */
  glassTransparency: number;
  /** `#rrggbb` the glass is tinted with; `null` keeps the surface it sits on. */
  glassTint: string | null;
  /** A zone's own tuning; an absent zone follows the general one above. */
  glassZones: Partial<Record<GlassZone, GlassTuning>>;
  /** Least opacity, in %, of the zones that carry text (islands, widgets, bubbles): the readability floor. */
  glassFloor: number;
  /** `#rrggbb` canvas of the dark scheme: every neutral level follows it (`ambientShades`). `null` keeps the native greys. */
  tintDark: string | null;
  /** Same for the light scheme. */
  tintLight: string | null;
};
export const GLASS_BLUR_RANGE = { min: 0, max: 40, default: 16 } as const;
/** Hidden until finished (`lib/glass-scope.ts`): what a row already holds is not painted, but stays stored. */
export { GLASS_TUNING_ENABLED };
export const GLASS_FLOOR_RANGE = { min: 0, max: 90, default: 0 } as const;
/**
 * The parts of the screen whose glass can be tuned apart: `chrome` (top bar,
 * side menu, gutters), `islands` (each island's plate), `widgets` (cards, the
 * chat's reading column, popups), `bubbles` (chat bubbles).
 */
export const GLASS_ZONES = ['chrome', 'islands', 'widgets', 'bubbles'] as const;
export type GlassZone = typeof GLASS_ZONES[number];
export type GlassTuning = { blur: number; transparency: number; tint: string | null };
/** The prefix of a zone's custom properties in `globals.css`. */
const ZONE_CSS: Record<GlassZone, string> = { chrome: 'chrome', islands: 'island', widgets: 'widget', bubbles: 'bubble' };
/** The zones the readability floor holds up: the ones text is written on. */
const TEXT_ZONES: ReadonlySet<GlassZone> = new Set(['islands', 'widgets', 'bubbles']);
export const GLASS_TRANSPARENCY_RANGE = { min: 0, max: 100, default: 40 } as const;
export const DEFAULT_APPEARANCE: NativeAppearance = { variant: 'teal', primary: null, glass: false, glassBubbles: false, glassScope: DEFAULT_GLASS_SCOPE, widgetsBorderless: true, widgetsTransparent: false, widgetsStyleAt: 0, glassBlur: GLASS_BLUR_RANGE.default, glassTransparency: GLASS_TRANSPARENCY_RANGE.default, glassTint: null, glassZones: {}, glassFloor: GLASS_FLOOR_RANGE.default, tintDark: null, tintLight: null };
const HEX = /^#[0-9a-f]{6}$/i;
function readHex(value: unknown): string | null {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null;
}
function readRange(value: unknown, range: { min: number; max: number; default: number }): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(range.max, Math.max(range.min, value))) : range.default;
}
function readGlassTuning(raw: unknown): GlassTuning | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  return { blur: readRange(row.blur, GLASS_BLUR_RANGE), transparency: readRange(row.transparency, GLASS_TRANSPARENCY_RANGE), tint: readHex(row.tint) };
}
function readGlassZones(raw: unknown): Partial<Record<GlassZone, GlassTuning>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Partial<Record<GlassZone, GlassTuning>> = {};
  for (const zone of GLASS_ZONES) {
    const tuning = readGlassTuning((raw as Record<string, unknown>)[zone]);
    if (tuning) out[zone] = tuning;
  }
  return out;
}
/** A zone's tuning: its own when it has one, else the general one. */
export function glassTuningOf(appearance: Pick<NativeAppearance, 'glassBlur' | 'glassTransparency' | 'glassTint' | 'glassZones'>, zone: GlassZone | 'general'): GlassTuning {
  const own = zone === 'general' ? undefined : appearance.glassZones[zone];
  return own ?? { blur: appearance.glassBlur, transparency: appearance.glassTransparency, tint: appearance.glassTint };
}
export function readNativeAppearance(raw: unknown): NativeAppearance {
  const row = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    variant: readThemeVariant(raw),
    primary: readHex(row.primary),
    glass: row.glass === true,
    glassBubbles: row.glassBubbles === true,
    glassScope: readGlassScope(row.glassScope) ?? DEFAULT_GLASS_SCOPE,
    // Borderless unless the user switched it off: an install that never saved this key starts without borders.
    widgetsBorderless: row.widgetsBorderless !== false,
    widgetsTransparent: row.widgetsTransparent === true,
    widgetsStyleAt: typeof row.widgetsStyleAt === 'number' && Number.isFinite(row.widgetsStyleAt) && row.widgetsStyleAt > 0 ? row.widgetsStyleAt : 0,
    glassBlur: readRange(row.glassBlur, GLASS_BLUR_RANGE),
    glassTransparency: readRange(row.glassTransparency, GLASS_TRANSPARENCY_RANGE),
    glassTint: readHex(row.glassTint),
    glassZones: readGlassZones(row.glassZones),
    glassFloor: readRange(row.glassFloor, GLASS_FLOOR_RANGE),
    tintDark: readHex(row.tintDark),
    tintLight: readHex(row.tintLight),
  };
}

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}
function luminance(h: number, s: number, l: number): number {
  const light = l / 100, a = s / 100 * Math.min(light, 1 - light);
  const channel = (n: number) => { const k = (n + h / 30) % 12; const c = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
  return .2126 * channel(0) + .7152 * channel(8) + .0722 * channel(4);
}
function contrast(a: number, b: number): number { return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }
/**
 * A free colour, turned into the two accents a variant carries. Hue and
 * saturation are the user's; only the lightness moves, and only as far as the
 * five native variants are held to (theme-variants.test.ts): 4.5:1 against the
 * button text and against the surfaces the accent is written on. A navy picked
 * in dark mode would otherwise put unreadable links on a near-black card.
 */
export function customPrimaryShades(hex: string): { dark: string; light: string } {
  const [h, s, l] = hexToHsl(hex);
  // Button text and the darkest/lightest surface an accent sits on, per scheme.
  const darkBg = [luminance(0, 0, 8), luminance(220, 9, 16)];
  const lightBg = [luminance(0, 0, 100), luminance(220, 12, 94)];
  let dl = Math.round(l), ll = Math.round(l);
  while (dl < 98 && darkBg.some((bg) => contrast(luminance(h, s, dl), bg) < 4.5)) dl += 1;
  while (ll > 2 && lightBg.some((bg) => contrast(luminance(h, s, ll), bg) < 4.5)) ll -= 1;
  const fmt = (lightness: number) => `${Math.round(h)} ${Math.round(s)}% ${lightness}%`;
  return { dark: fmt(dl), light: fmt(ll) };
}

/** `"h s% l%"` → `#rrggbb`: seeds the colour picker with the accent on screen. */
export function hslTripleToHex(triple: string): string {
  const [h, s, l] = (triple.match(/[\d.]+/g) ?? ['0', '0', '50']).map(Number) as [number, number, number];
  const light = l / 100, a = s / 100 * Math.min(light, 1 - light);
  const channel = (n: number) => { const k = (n + h / 30) % 12; return Math.round((light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0'); };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

export function themeVariantCss(id: ThemeVariant, primary: string | null = null): string {
  const v = THEME_VARIANTS.find((v) => v.id === id) ?? THEME_VARIANTS.find((v) => v.id === 'teal')!;
  const accent = primary && HEX.test(primary) ? customPrimaryShades(primary) : { dark: v.dark, light: v.light };
  return `:root { --primary: ${accent.dark}; --border: ${v.borderDark}; --input: var(--border); --radius: ${v.radius}px; }
:root.light { --primary: ${accent.light}; --border: ${v.borderLight}; --input: var(--border); }
:root, :root.light { --accent: var(--primary); --ring: var(--primary); --salmon: var(--primary); --salmon-2: var(--primary); --salmon-3: var(--primary); --salmon-soft: var(--primary) / 0.12; --rooks-scrollbar-thumb: hsl(var(--primary) / 0.32); --rooks-scrollbar-thumb-hover: hsl(var(--primary) / 0.52); }`;
}

/**
 * The native neutral scale (`ui-theme-tokens.ts`), per scheme. A tint moves
 * the whole scale at once, so the steps between levels — what tells a card
 * from the canvas, a field from a card — survive whatever colour is picked.
 */
const NEUTRAL_SCALE = {
  dark: { '--surface-0': 11, '--surface-1': 13.5, '--surface-2': 16.5, '--surface-3': 18.5, '--surface-4': 22.5, '--surface-sunken': 8.5, '--chrome': 3.5 },
  light: { '--surface-0': 97, '--surface-1': 100, '--surface-2': 94, '--surface-3': 100, '--surface-4': 91, '--surface-sunken': 94, '--chrome': 89, '--surface-chip': 94 },
} as const;
/** How far the canvas may move: past these, the native text colours lose their contrast. */
export const TINT_CANVAS_RANGE = { dark: { min: 5, max: 16 }, light: { min: 86, max: 100 } } as const;
const TINT_MAX_SATURATION = 60;
const clampPct = (n: number) => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;

/**
 * One picked colour → every neutral level of a scheme. The colour is the
 * canvas: its hue and saturation colour every level, and its lightness moves
 * the whole scale by the same amount (within `TINT_CANVAS_RANGE`). Borders and
 * secondary text take the hue too, with less saturation, so a blue-grey
 * theme has no warm-grey outline left over.
 */
export function ambientShades(hex: string, scheme: 'dark' | 'light', borderLightness: number): Record<string, string> {
  const [h, s, l] = hexToHsl(hex);
  const range = TINT_CANVAS_RANGE[scheme];
  const scale = NEUTRAL_SCALE[scheme];
  const shift = Math.min(range.max, Math.max(range.min, l)) - scale['--surface-0'];
  // Past this, a canvas reads as a colour, not as a tinted grey, and the
  // luminance of a pure hue drifts far from what its lightness promises.
  const hue = Math.round(h), sat = clampPct(Math.min(s, TINT_MAX_SATURATION));
  const out: Record<string, string> = {};
  for (const [token, lightness] of Object.entries(scale)) out[token] = `${hue} ${sat}% ${clampPct(lightness + shift)}%`;
  out['--border'] = `${hue} ${clampPct(Math.min(s, 40))}% ${clampPct(borderLightness + shift)}%`;
  // Secondary text moves away from the raised level until it reads at 4.5:1 again:
  // a lighter canvas, or a saturated hue whose luminance runs high, would sink it.
  const mutedSat = clampPct(Math.min(s, 16));
  const raised = luminance(hue, sat, clampPct(scale['--surface-4'] + shift));
  let muted = scheme === 'dark' ? 70 : 40;
  while (muted > 0 && muted < 100 && contrast(luminance(hue, mutedSat, muted), raised) < 4.5) muted += scheme === 'dark' ? 1 : -1;
  out['--muted-foreground'] = `${hue} ${mutedSat}% ${muted}%`;
  return out;
}
const lightnessOf = (triple: string) => Number((triple.match(/[\d.]+/g) ?? [])[2] ?? 0);

type GlassVarsInput = Pick<NativeAppearance, 'glassBlur' | 'glassTransparency' | 'glassTint'> & Partial<Pick<NativeAppearance, 'glassZones' | 'glassFloor'>>;
/** Each zone's blur, opacity and tint: the custom properties `globals.css` reads. */
function glassVars(appearance: GlassVarsInput): Record<string, string> {
  const full = { glassZones: {}, glassFloor: 0, ...appearance };
  const out: Record<string, string> = {};
  for (const zone of GLASS_ZONES) {
    const tuning = glassTuningOf(full, zone);
    const prefix = `--rooks-glass-${ZONE_CSS[zone]}`;
    const opacity = 1 - tuning.transparency / 100;
    const floored = TEXT_ZONES.has(zone) ? Math.max(opacity, full.glassFloor / 100) : opacity;
    out[`${prefix}-blur`] = `${tuning.blur}px`;
    out[`${prefix}-alpha`] = String(Math.round(floored * 1000) / 1000);
    if (tuning.tint && HEX.test(tuning.tint)) {
      const [h, s, l] = hexToHsl(tuning.tint);
      out[`${prefix}-tone`] = `${Math.round(h)} ${clampPct(s)}% ${clampPct(l)}%`;
    }
  }
  return out;
}
export function glassCss(appearance: GlassVarsInput): string {
  return `:root { ${Object.entries(glassVars(appearance)).map(([k, v]) => `${k}: ${v};`).join(' ')} }`;
}
const borderLightness = (appearance: NativeAppearance, scheme: 'dark' | 'light') => {
  const v = THEME_VARIANTS.find((x) => x.id === appearance.variant) ?? THEME_VARIANTS.find((x) => x.id === 'teal')!;
  return lightnessOf(scheme === 'dark' ? v.borderDark : v.borderLight);
};

/**
 * What a colour picker or a slider changes, for the scheme on screen, as
 * properties to set inline on `<html>` while the hand moves. Rewriting the
 * theme's whole stylesheet on every pixel of a drag reparsed it and restyled
 * the whole page each time — about one frame a second under the glass. The
 * stylesheet is written once, when the hand stops (`appearanceCss`).
 */
/** The row as it is painted: while glass tuning is hidden, its fields fall back on their defaults. */
export function effectiveGlass<T extends Partial<NativeAppearance>>(appearance: T): T {
  if (GLASS_TUNING_ENABLED) return appearance;
  return {
    ...appearance,
    ...('glassBlur' in appearance ? { glassBlur: GLASS_BLUR_RANGE.default, glassTransparency: GLASS_TRANSPARENCY_RANGE.default, glassTint: null, glassZones: {}, glassFloor: GLASS_FLOOR_RANGE.default } : {}),
    ...(appearance.glassScope === 'both' ? { glassScope: 'island' as const } : {}),
  };
}

export function appearancePreviewVars(appearance: NativeAppearance, scheme: 'dark' | 'light'): Record<string, string> {
  const out: Record<string, string> = glassVars(effectiveGlass(appearance));
  if (appearance.primary && HEX.test(appearance.primary)) out['--primary'] = customPrimaryShades(appearance.primary)[scheme];
  const tint = scheme === 'dark' ? appearance.tintDark : appearance.tintLight;
  if (tint && HEX.test(tint)) {
    Object.assign(out, ambientShades(tint, scheme, borderLightness(appearance, scheme)));
    out['--input'] = 'var(--border)';
  }
  return out;
}

/** Everything the native Appearance row paints: accent, geometry, ambient tint, glass. */
export function appearanceCss(appearance: NativeAppearance): string {
  const tint = (hex: string | null, scheme: 'dark' | 'light', selector: string) => {
    if (!hex || !HEX.test(hex)) return '';
    const tokens = ambientShades(hex, scheme, borderLightness(appearance, scheme));
    return `\n${selector} { ${Object.entries(tokens).map(([k, val]) => `${k}: ${val};`).join(' ')} --input: var(--border); }`;
  };
  const painted = effectiveGlass(appearance);
  return themeVariantCss(appearance.variant, appearance.primary)
    + tint(appearance.tintDark, 'dark', ':root')
    + tint(appearance.tintLight, 'light', ':root.light')
    + '\n' + glassCss(painted);
}

/** Mirrors the glass switches and the site-wide widget style onto `<html>`,
 *  where `globals.css` and the widget cards read them. The server sets the same
 *  attributes on first paint (`app/layout.tsx`). */
export function applyGlassAttributes(appearance: Pick<NativeAppearance, 'glass' | 'glassBubbles'> & Partial<Pick<NativeAppearance, 'glassScope' | 'widgetsBorderless' | 'widgetsTransparent' | 'widgetsStyleAt'>>): void {
  const root = document.documentElement;
  appearance = effectiveGlass(appearance);
  root.toggleAttribute('data-glass', appearance.glass);
  root.toggleAttribute('data-glass-bubbles', appearance.glassBubbles);
  root.setAttribute(GLASS_SCOPE_ATTRIBUTE, appearance.glassScope ?? DEFAULT_GLASS_SCOPE);
  root.toggleAttribute('data-widgets-borderless', appearance.widgetsBorderless === true);
  root.toggleAttribute('data-widgets-transparent', appearance.widgetsTransparent === true);
  root.setAttribute('data-widgets-style-at', String(appearance.widgetsStyleAt ?? 0));
  window.dispatchEvent(new CustomEvent(GLASS_EVENT));
}
export const GLASS_EVENT = 'rooks:glass';
