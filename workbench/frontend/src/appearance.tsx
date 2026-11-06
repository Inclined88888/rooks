import { useEffect, useState } from "react";

/**
 * Appearance: theme, type, size, density, motion and accent. One object in localStorage, applied to <html> as data
 * attributes and CSS variables, so every page restyles live without a reload. Studio (light) and Lamp (dark) are the
 * two first class looks (tokens.css, keyed on data-mode); Sunshine, Paper, Cherry & Ink, Neon and High contrast stay
 * available as colour layers on top, plus "Match my system". The choice is also saved to the backend so the desktop
 * window, Rooks Code, Rooks Browser and the phone follow it. Anyone who already saved their own choices keeps them
 * (Linen still works, it is just not offered). The ids "gallery" and "night" are kept for saved settings.
 */
export type ThemeId = "sunshine" | "paper" | "cherry" | "neon" | "night" | "contrast" | "auto" | "linen" | "gallery";
export type FontId = "editorial" | "modern" | "classic" | "system";
export type MotionId = "full" | "subtle" | "off";
export type AccentId = "theme" | "sun" | "cherry" | "ink" | "cobalt" | "forest" | "ochre";
export type Appearance = { theme: ThemeId; font: FontId; size: number; density: "comfortable" | "compact"; motion: MotionId; accent: AccentId };

/** "theme" accent = each theme's own designed accent (Sunshine's sun, Cherry's red, Neon's lime...). */
export const DEFAULTS: Appearance = { theme: "gallery", font: "modern", size: 14, density: "comfortable", motion: "full", accent: "theme" };
const KEY = "wb-appearance";
const LEGACY = "wb-theme";

export type ThemeInfo = { id: ThemeId; label: string; note: string; mode: "light" | "dark" | "auto";
  /** paper, panel, text, muted, accent, on-accent: used to draw the mini preview on picker cards */
  swatch: { paper: string; panel: string; text: string; muted: string; accent: string; onAccent: string; border: string } };

/** The curated six, plus "Match my system". Linen and Gallery stay valid for anyone who saved them, just not offered. */
export const THEMES: ThemeInfo[] = [
  { id: "gallery", label: "Studio", note: "Warm paper, ink type, one saffron signal. The everyday look.", mode: "light",
    swatch: { paper: "#faf8f3", panel: "#ffffff", text: "#1b1a17", muted: "#5f5a50", accent: "#f2b705", onAccent: "#1b1a17", border: "#e6e1d6" } },
  { id: "sunshine", label: "Sunshine", note: "Bright, warm and airy.", mode: "light",
    swatch: { paper: "#fffdf8", panel: "#ffffff", text: "#2a2620", muted: "#615a4e", accent: "#ffc83d", onAccent: "#2a2000", border: "#f0e9da" } },
  { id: "paper", label: "Paper", note: "Soft newsprint, quiet ink.", mode: "light",
    swatch: { paper: "#f5f1e8", panel: "#fbf9f4", text: "#141311", muted: "#5a554c", accent: "#141311", onAccent: "#f5f1e8", border: "#dcd5c6" } },
  { id: "cherry", label: "Cherry & Ink", note: "Crisp white, black ink, one red.", mode: "light",
    swatch: { paper: "#fbf8f3", panel: "#ffffff", text: "#141311", muted: "#57524a", accent: "#c8102e", onAccent: "#ffffff", border: "#e2dace" } },
  { id: "neon", label: "Neon", note: "Ink black with one electric lime.", mode: "dark",
    swatch: { paper: "#0b0d10", panel: "#12151a", text: "#e9eef2", muted: "#a3adb8", accent: "#d4ff3a", onAccent: "#0b0d10", border: "#262b33" } },
  { id: "night", label: "Lamp", note: "Dark paper, soft ink, the same saffron. Easy at night.", mode: "dark",
    swatch: { paper: "#141210", panel: "#1c1915", text: "#f2ede3", muted: "#b0a89a", accent: "#f2b705", onAccent: "#141210", border: "#2e2a24" } },
  { id: "contrast", label: "High contrast", note: "Pure black on white, bold edges.", mode: "light",
    swatch: { paper: "#ffffff", panel: "#ffffff", text: "#000000", muted: "#1f1f1f", accent: "#0033aa", onAccent: "#ffffff", border: "#000000" } },
  { id: "auto", label: "Match my system", note: "Studio by day, Lamp when your computer is dark.", mode: "auto",
    swatch: { paper: "#faf8f3", panel: "#141210", text: "#1b1a17", muted: "#b0a89a", accent: "#f2b705", onAccent: "#1b1a17", border: "#e6e1d6" } },
];
const HIDDEN_THEMES: ThemeId[] = ["linen"];
/** Themes with a hand-tuned palette whose accent never changes (an accent picked elsewhere would break contrast). */
const FIXED_ACCENT: ThemeId[] = ["neon", "contrast"];
export const DARK_THEMES: ThemeId[] = ["night", "neon"];

/** "auto" resolves to Studio or Lamp from the OS setting, so data-mode is always one of light or dark. */
export function resolveTheme(t: ThemeId): Exclude<ThemeId, "auto"> {
  if (t !== "auto") return t;
  const dark = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return dark ? "night" : "gallery";
}
export const isDark = (t: ThemeId) => DARK_THEMES.includes(resolveTheme(t));

export const FONTS: { id: FontId; label: string; note: string; display: string; body: string }[] = [
  { id: "editorial", label: "Editorial", note: "Bodoni Moda + Hanken Grotesk", display: '"Bodoni Moda Variable", Didot, serif', body: '"Hanken Grotesk Variable", Helvetica, sans-serif' },
  { id: "modern", label: "Clean", note: "Hanken Grotesk throughout, the default", display: '"Hanken Grotesk Variable", Helvetica, sans-serif', body: '"Hanken Grotesk Variable", Helvetica, sans-serif' },
  { id: "classic", label: "Classic", note: "Bodoni Moda + a book serif", display: '"Bodoni Moda Variable", Didot, serif', body: 'Charter, "Iowan Old Style", Georgia, serif' },
  { id: "system", label: "System", note: "Your computer's own fonts", display: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
];
export const ACCENTS: { id: AccentId; label: string; color: string }[] = [
  { id: "theme", label: "Theme's own", color: "conic-gradient(#ffc83d 0 25%, #c8102e 0 50%, #d4ff3a 0 75%, #141311 0)" },
  { id: "sun", label: "Sun", color: "#ffc83d" },
  { id: "cherry", label: "Cherry", color: "#d21f3c" },
  { id: "ink", label: "Ink", color: "#141311" },
  { id: "cobalt", label: "Cobalt", color: "#2343b8" },
  { id: "forest", label: "Forest", color: "#2d6236" },
  { id: "ochre", label: "Ochre", color: "#a8660a" },
];
export const SIZES = { min: 12, max: 18 };

// Base sizes at 14px, the same numbers tokens.css declares; every text token scales with the slider.
const TEXT_TOKENS: [string, number][] = [["--text-2xs", 10.5], ["--text-xs", 12], ["--text-sm", 13], ["--text-md", 14], ["--text-lg", 16],
  ["--text-xl", 20], ["--text-2xl", 28], ["--text-3xl", 40], ["--text-4xl", 56], ["--text-thread", 15], ["--text-mono", 12.5], ["--text-rail", 11]];

export function readAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
    if (localStorage.getItem(LEGACY) === "dark") return { ...DEFAULTS, theme: "night" };
  } catch {
    /* storage unavailable or corrupt */
  }
  return DEFAULTS;
}

function sanitize(v: Partial<Appearance>): Appearance {
  const pick = <T extends string>(x: unknown, ok: readonly T[], d: T): T => (ok.includes(x as T) ? (x as T) : d);
  const size = Number(v.size);
  return {
    theme: pick(v.theme, [...THEMES.map((t) => t.id), ...HIDDEN_THEMES], DEFAULTS.theme),
    font: pick(v.font, FONTS.map((f) => f.id), DEFAULTS.font),
    size: Number.isFinite(size) ? Math.min(SIZES.max, Math.max(SIZES.min, Math.round(size))) : DEFAULTS.size,
    density: v.density === "compact" ? "compact" : "comfortable",
    motion: pick(v.motion, ["full", "subtle", "off"] as const, DEFAULTS.motion),
    accent: pick(v.accent, ACCENTS.map((a) => a.id), DEFAULTS.accent),
  };
}

/** Apply to a root element (the document, or a preview box). */
export function applyTo(el: HTMLElement, a: Appearance) {
  const theme = resolveTheme(a.theme);
  el.dataset.theme = theme === "night" ? "dark" : theme; // the saved id; the palette itself follows data-mode
  el.dataset.mode = DARK_THEMES.includes(theme) ? "dark" : "light";
  el.dataset.font = a.font;
  el.dataset.density = a.density;
  // the OS "reduce motion" setting is applied as Off, so every still state keyed on data-motion="off" holds; the saved
  // choice is kept (the Appearance page explains why nothing moves)
  const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.dataset.motion = reduced ? "off" : a.motion;
  el.dataset.accent = FIXED_ACCENT.includes(theme) ? "theme" : a.accent;
  const scale = a.size / 14;
  for (const [name, base] of TEXT_TOKENS) {
    if (scale === 1) el.style.removeProperty(name);
    else el.style.setProperty(name, `${Math.round(base * scale * 10) / 10}px`);
  }
}

export function setAppearance(next: Partial<Appearance>) {
  const a = sanitize({ ...readAppearance(), ...next });
  applyTo(document.documentElement, a);
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
    localStorage.removeItem(LEGACY);
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent("wb:appearance", { detail: a }));
  for (const fn of listeners) fn(a);
}

/** Other surfaces (the desktop window chrome, the backend copy that Rooks and the phone read) subscribe here. */
const listeners = new Set<(a: Appearance) => void>();
export function onAppearance(fn: (a: Appearance) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Choosing a theme also returns the accent to the theme's own, so every palette shows as designed. */
export function pickTheme(theme: ThemeId) {
  setAppearance({ theme, accent: "theme" });
}

/** Keep "Match my system" live when the OS flips between light and dark, and re-apply when its motion setting changes. */
export function followSystem(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const onScheme = () => { const a = readAppearance(); if (a.theme === "auto") setAppearance({}); };
  const onReduce = () => setAppearance({});
  scheme?.addEventListener?.("change", onScheme);
  reduce?.addEventListener?.("change", onReduce);
  return () => { scheme?.removeEventListener?.("change", onScheme); reduce?.removeEventListener?.("change", onReduce); };
}

export function useAppearance(): [Appearance, (p: Partial<Appearance>) => void] {
  const [a, setA] = useState<Appearance>(readAppearance);
  useEffect(() => {
    const on = (e: Event) => setA((e as CustomEvent<Appearance>).detail);
    window.addEventListener("wb:appearance", on);
    return () => window.removeEventListener("wb:appearance", on);
  }, []);
  return [a, setAppearance];
}

/** True when nothing should move: the user chose Off, or the OS asks for reduced motion. */
export function motionOff(): boolean {
  if (typeof window === "undefined") return true;
  return document.documentElement.dataset.motion === "off" || !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
