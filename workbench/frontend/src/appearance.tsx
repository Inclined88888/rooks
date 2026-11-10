import { useEffect, useState } from "react";

/**
 * Appearance: theme, typeface, text size, spacing and motion. One object in localStorage, applied to <html> as data
 * attributes and CSS variables, so every page restyles live without a reload. Design system v3 (docs/design/
 * 0003-workroom.md, section 6) has three themes, keyed on data-mode in tokens.css: Light, Dark and High contrast, plus
 * "Match my computer". A choice saved under an older theme is mapped on load (night, lamp, neon, cherry become Dark;
 * contrast stays High contrast; everything else becomes Light). The choice is also saved to the backend so the desktop
 * window, Rooks Code, Rooks Browser and the phone follow it (themeSync.ts).
 */
export type ThemeId = "light" | "dark" | "contrast" | "auto";
export type FontId = "modern" | "system";
export type MotionId = "full" | "off";
export type Appearance = { theme: ThemeId; font: FontId; size: number; density: "comfortable" | "compact"; motion: MotionId };

export const DEFAULTS: Appearance = { theme: "light", font: "modern", size: 14, density: "comfortable", motion: "full" };
const KEY = "wb-appearance";
const LEGACY = "wb-theme";

export type ThemeInfo = { id: ThemeId; label: string; note: string; mode: "light" | "dark" | "contrast" | "auto";
  /** paper, panel, text, muted, border: used for the picker's small preview and the desktop window's background */
  swatch: { paper: string; panel: string; text: string; muted: string; border: string; live: string } };

const LIGHT = { paper: "#fafaf9", panel: "#ffffff", text: "#1a1a19", muted: "#5e5d59", border: "#e7e6e3", live: "#c98a00" };
const DARK = { paper: "#161616", panel: "#1e1e1e", text: "#ededec", muted: "#a3a29e", border: "#2e2e2e", live: "#e3a82b" };
const CONTRAST = { paper: "#ffffff", panel: "#ffffff", text: "#000000", muted: "#262626", border: "#000000", live: "#8a5a00" };

export const THEMES: ThemeInfo[] = [
  { id: "light", label: "Light", note: "Quiet greys on white. The everyday look.", mode: "light", swatch: LIGHT },
  { id: "dark", label: "Dark", note: "The same calm look, easy at night.", mode: "dark", swatch: DARK },
  { id: "contrast", label: "High contrast", note: "Black on white, bold edges, a thicker focus ring.", mode: "contrast", swatch: CONTRAST },
  { id: "auto", label: "Match my computer", note: "Light by day, Dark when your computer is dark.", mode: "auto", swatch: LIGHT },
];
const IDS = THEMES.map((t) => t.id);

/** A theme saved by an older version, mapped to one of the three. */
export function mapTheme(saved: unknown): ThemeId {
  if (typeof saved !== "string") return DEFAULTS.theme;
  if ((IDS as string[]).includes(saved)) return saved as ThemeId;
  if (["night", "lamp", "neon", "cherry"].includes(saved)) return "dark";
  return "light";
}

/** "auto" resolves to Light or Dark from the computer's setting. */
export function resolveTheme(t: ThemeId): Exclude<ThemeId, "auto"> {
  if (t !== "auto") return t;
  const dark = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return dark ? "dark" : "light";
}
export const isDark = (t: ThemeId) => resolveTheme(t) === "dark";

export const FONTS: { id: FontId; label: string; note: string; body: string }[] = [
  { id: "modern", label: "Clean", note: "Hanken Grotesk, the default", body: '"Hanken Grotesk Variable", Helvetica, sans-serif' },
  { id: "system", label: "System", note: "Your computer's own fonts", body: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
];
export const SIZES = { min: 12, max: 18 };

// Base sizes at 14px, the same numbers tokens.css declares; every text token scales with the slider.
const TEXT_TOKENS: [string, number][] = [["--text-2xs", 12], ["--text-xs", 12], ["--text-sm", 13], ["--text-md", 14], ["--text-lg", 16],
  ["--text-xl", 20], ["--text-2xl", 28], ["--text-3xl", 28], ["--text-4xl", 28], ["--text-thread", 16], ["--text-mono", 13]];

export function readAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
    if (localStorage.getItem(LEGACY) === "dark") return { ...DEFAULTS, theme: "dark" };
  } catch {
    /* storage unavailable or corrupt */
  }
  return DEFAULTS;
}

function sanitize(v: Partial<Record<keyof Appearance, unknown>>): Appearance {
  const size = Number(v.size);
  return {
    theme: v.theme === undefined ? DEFAULTS.theme : mapTheme(v.theme),
    font: v.font === "system" ? "system" : "modern",
    size: Number.isFinite(size) ? Math.min(SIZES.max, Math.max(SIZES.min, Math.round(size))) : DEFAULTS.size,
    density: v.density === "compact" ? "compact" : "comfortable",
    // the old Calm level means on: only fades remain, and Off still turns those off
    motion: v.motion === "off" ? "off" : "full",
  };
}

/** Apply to a root element (the document, or a preview box). */
export function applyTo(el: HTMLElement, a: Appearance) {
  const theme = resolveTheme(a.theme);
  el.dataset.theme = theme;
  el.dataset.mode = theme;
  el.dataset.font = a.font;
  el.dataset.density = a.density;
  // the OS "reduce motion" setting is applied as Off, so the fades stop whatever was picked; the saved choice is kept
  const reduced = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.dataset.motion = reduced ? "off" : a.motion;
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

export function pickTheme(theme: ThemeId) {
  setAppearance({ theme });
}

/** Keep "Match my computer" live when the OS flips between light and dark, and re-apply when its motion setting changes. */
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

/** True when nothing should fade: the user chose Off, or the OS asks for reduced motion. */
export function motionOff(): boolean {
  if (typeof window === "undefined") return true;
  return document.documentElement.dataset.motion === "off" || !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
