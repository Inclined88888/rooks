// Unit tests for the Appearance store (src/appearance.tsx), run with Node's built-in runner: `npm test`.
// esbuild (already installed with Vite) compiles the module; the browser globals are small stubs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const out = await build({ entryPoints: [new URL("../src/appearance.tsx", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false, external: ["react"] });
// Written under node_modules so the external `react` import resolves.
const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
mkdirSync(dir, { recursive: true });
const file = dir + "appearance.mjs";
writeFileSync(file, out.outputFiles[0].text);

const store = new Map();
let reduced = false;
let darkOS = false;
const events = [];
function fakeEl() {
  const props = new Map();
  return { dataset: {}, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), props } };
}
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = { documentElement: fakeEl() };
globalThis.window = { matchMedia: (q) => ({ matches: q.includes("reduced-motion") ? reduced : q.includes("dark") ? darkOS : false }), dispatchEvent: (e) => events.push(e) };
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail; } };

const ap = await import(pathToFileURL(file).href);

beforeEach(() => { store.clear(); reduced = false; darkOS = false; events.length = 0; document.documentElement = fakeEl(); });

test("defaults to Light, Clean type, 14px, motion on", () => {
  assert.deepEqual(ap.readAppearance(), ap.DEFAULTS);
  assert.deepEqual([ap.DEFAULTS.theme, ap.DEFAULTS.font, ap.DEFAULTS.motion], ["light", "modern", "full"]);
});

test("Light leads the list, then Dark, High contrast and Match my computer", () => {
  assert.deepEqual(ap.THEMES.map((t) => t.id), ["light", "dark", "contrast", "auto"]);
  for (const t of ap.THEMES) for (const c of Object.values(t.swatch)) assert.match(c, /^#[0-9a-f]{6}$/);
});

test("older saved themes, fonts and motion levels are mapped, not lost", () => {
  store.set("wb-appearance", JSON.stringify({ theme: "linen" }));
  assert.equal(ap.readAppearance().theme, "light");
  store.set("wb-appearance", JSON.stringify({ theme: "neon", font: "editorial", motion: "subtle", accent: "cherry" }));
  const a = ap.readAppearance();
  assert.deepEqual([a.theme, a.font, a.motion], ["dark", "modern", "full"]);
  assert.equal("accent" in a, false, "the accent is no longer a choice");
  store.set("wb-appearance", JSON.stringify({ theme: "contrast", font: "system", motion: "off" }));
  assert.deepEqual(Object.values(ap.readAppearance()).slice(0, 2), ["contrast", "system"]);
});

test("corrupt or hostile storage falls back to safe values", () => {
  store.set("wb-appearance", "{not json");
  assert.deepEqual(ap.readAppearance(), ap.DEFAULTS);
  store.set("wb-appearance", JSON.stringify({ theme: "purple", font: "<script>", size: 400, motion: "wild", density: "x" }));
  assert.deepEqual(ap.readAppearance(), { ...ap.DEFAULTS, size: ap.SIZES.max });
  store.set("wb-appearance", JSON.stringify({ size: -3 }));
  assert.equal(ap.readAppearance().size, ap.SIZES.min);
});

test("the old dark-theme setting migrates to Dark", () => {
  store.set("wb-theme", "dark");
  assert.equal(ap.readAppearance().theme, "dark");
});

test("applyTo writes data attributes and scales text tokens", () => {
  const el = fakeEl();
  ap.applyTo(el, { ...ap.DEFAULTS, theme: "dark", font: "system", size: 16, density: "compact", motion: "off" });
  assert.deepEqual({ ...el.dataset }, { theme: "dark", mode: "dark", font: "system", density: "compact", motion: "off" });
  assert.equal(el.style.props.get("--text-md"), "16px");
  assert.equal(el.style.props.get("--text-2xl"), "32px");
  ap.applyTo(el, ap.DEFAULTS);
  assert.deepEqual([el.dataset.theme, el.dataset.mode], ["light", "light"]);
  ap.applyTo(el, { ...ap.DEFAULTS, theme: "contrast" });
  assert.deepEqual([el.dataset.theme, el.dataset.mode], ["contrast", "contrast"]);
  assert.equal(el.style.props.size, 0, "14px removes overrides");
});

test("setAppearance persists, applies live and notifies open pages", () => {
  ap.setAppearance({ theme: "contrast", motion: "off" });
  assert.equal(JSON.parse(store.get("wb-appearance")).theme, "contrast");
  assert.equal(document.documentElement.dataset.mode, "contrast");
  assert.equal(events.at(-1).type, "wb:appearance");
  assert.equal(events.at(-1).detail.motion, "off");
  assert.equal(store.has("wb-theme"), false);
});

test("motion is off when the user chooses Off or the OS asks for reduced motion", () => {
  ap.applyTo(document.documentElement, ap.DEFAULTS);
  assert.equal(ap.motionOff(), false);
  reduced = true;
  assert.equal(ap.motionOff(), true);
  reduced = false;
  ap.applyTo(document.documentElement, { ...ap.DEFAULTS, motion: "off" });
  assert.equal(ap.motionOff(), true);
});

test("when the OS asks for reduced motion, applyTo turns motion off whatever was picked", () => {
  const el = fakeEl();
  reduced = true;
  ap.applyTo(el, { ...ap.DEFAULTS, motion: "full" });
  assert.equal(el.dataset.motion, "off", "the fades stop");
  reduced = false;
  ap.applyTo(el, { ...ap.DEFAULTS, motion: "full" });
  assert.equal(el.dataset.motion, "full", "the saved choice is kept, not overwritten");
});

test("Match my computer follows the OS: Light by day, Dark at night", () => {
  const el = fakeEl();
  ap.applyTo(el, { ...ap.DEFAULTS, theme: "auto" });
  assert.equal(el.dataset.mode, "light");
  darkOS = true;
  ap.applyTo(el, { ...ap.DEFAULTS, theme: "auto" });
  assert.deepEqual([el.dataset.theme, el.dataset.mode], ["dark", "dark"]);
  assert.equal(ap.isDark("auto"), true);
  assert.equal(ap.resolveTheme("contrast"), "contrast");
});

test("picking a theme tells subscribers (window chrome, backend copy)", () => {
  const seen = [];
  const off = ap.onAppearance((a) => seen.push(a.theme));
  ap.pickTheme("dark");
  off();
  ap.pickTheme("contrast");
  assert.deepEqual(seen, ["dark"]);
  assert.equal(ap.readAppearance().theme, "contrast");
});

test("the backend copy keeps the names Rooks Code and the phone know", () => {
  const sync = readFileSync(new URL("../src/themeSync.ts", import.meta.url), "utf8");
  assert.match(sync, /light: "gallery", dark: "night", contrast: "contrast", auto: "auto"/);
});
