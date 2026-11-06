/**
 * Helpers for a project's visual identity (derived color, kind of icon).
 *
 * Same algorithm as `autoColorFor` on the orchestrator side: a project with no
 * explicit color must render the SAME hue everywhere (database, canvas,
 * cards), otherwise the cue "this color = this project" breaks from one screen
 * to the next.
 */

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** A stable color derived from a name / slug. */
export function autoColor(input: string): string {
  let h = 0;
  for (const ch of input) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return hslToHex(h % 360, 65, 55);
}

/** true when the icon is an image to load (http(s) URL or a TIMON upload),
 *  false when it is an emoji / initials to render as text. */
export function isIconUrl(icon: string | null | undefined): boolean {
  if (!icon) return false;
  return icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('/');
}
