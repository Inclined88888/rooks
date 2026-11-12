export type VoiceSphereState = 'listening' | 'speaking' | 'thinking';

/** Body gradient A→B (driven by the noise) plus the emission colour. */
export type VoiceSpherePalette = { a: string; b: string; glow: string };

export type VoiceSpherePalettes = Record<VoiceSphereState, VoiceSpherePalette>;

/** Only used when no theme has painted `--primary` yet (or it is unreadable). */
export const FALLBACK_PALETTES: VoiceSpherePalettes = {
  listening: { a: '#c2410c', b: '#c2410c', glow: '#fb923c' },
  speaking: { a: '#fbbf24', b: '#f97316', glow: '#fde68a' },
  thinking: { a: '#7c2d12', b: '#ea580c', glow: '#f97316' },
};

type Hsl = { h: number; s: number; l: number };

/** Parses the `--primary` token: `13 67% 63%` (shadcn form), also tolerating
 *  commas and an `hsl(...)` wrapper a third-party theme may write. */
export function parsePrimaryHsl(raw: string | null | undefined): Hsl | null {
  if (!raw) return null;
  const inner = raw.trim().replace(/^hsla?\(/i, '').replace(/\)$/, '');
  const parts = inner.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const [h, s, l] = parts.slice(0, 3).map((p) => Number.parseFloat(p.replace(/deg$|%$/i, '')));
  if (h === undefined || s === undefined || l === undefined) return null;
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  return { h, s, l };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** `THREE.Color.setStyle` splits `hsl()` on commas, so the output keeps them. */
function hsl(h: number, s: number, l: number): string {
  const hue = ((Math.round(h) % 360) + 360) % 360;
  return `hsl(${hue}, ${Math.round(clamp(s, 0, 100))}%, ${Math.round(clamp(l, 0, 100))}%)`;
}

/**
 * The three sphere states, all derived from the theme's primary colour.
 *
 * The orb is the loudest element on screen: it must speak the theme's colour,
 * whatever that colour is. States stay apart through lightness and saturation
 * rather than hue — a few degrees of drift only, so the orb never reads as a
 * second accent. Speaking is the brightest, thinking the darkest. The base
 * lightness is clamped so a very pale or very dark primary still leaves room
 * for the three states to differ.
 */
export function derivePalettes(rawPrimary: string | null | undefined): VoiceSpherePalettes {
  const base = parsePrimaryHsl(rawPrimary);
  if (!base) return FALLBACK_PALETTES;
  const { h, s } = base;
  const l = clamp(base.l, 40, 62);
  return {
    listening: {
      a: hsl(h - 8, s, l - 16),
      b: hsl(h, s, l),
      glow: hsl(h + 6, s + 10, l + 14),
    },
    speaking: {
      a: hsl(h + 16, s + 15, l + 12),
      b: hsl(h + 6, s + 10, l + 4),
      glow: hsl(h + 18, s, l + 26),
    },
    thinking: {
      a: hsl(h - 12, s, l - 34),
      b: hsl(h - 6, s, l - 14),
      glow: hsl(h - 4, s, l - 2),
    },
  };
}
