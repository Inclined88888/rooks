// Design system v3, "restraint" (docs/design/0003-workroom.md, section 6): the foundation of the premium pass.
// Bodoni is gone, three themes (plus Match my computer) with saved choices mapped, no Motion page, and every text pair
// in tokens.css is AA, computed from the file itself. The industrial redesign (v4, tests/industrial-tokens.test.mjs)
// changed what four of these guard, on purpose: the palette, the type scale (adds 10/11 px micro-labels and 15 px
// body), square corners and no floating shadow, and two more motions beside the fade (the orange headline wipe and
// the line draw-in, both under the same reduced-motion and Motion off rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
function walk(dir, out = []) {
  for (const n of readdirSync(root + dir)) {
    const p = `${dir}/${n}`;
    if (statSync(root + p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const srcFiles = walk("src");
const cssFiles = srcFiles.filter((f) => f.endsWith(".css"));
const codeFiles = srcFiles.filter((f) => /\.(tsx?|mjs|css)$/.test(f));

/* ------------------------------------------------------------------ motion */

test("the only keyframes are the fade (ui-fade, 150 ms or less), the headline wipe and the line draw, all in ui/ui.css", () => {
  const names = [];
  for (const f of codeFiles) {
    for (const m of strip(read(f)).matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) names.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(names, ["src/ui/ui.css: ui-fade", "src/ui/ui.css: ui-wipe", "src/ui/ui.css: ui-draw"], `keyframes found: ${names.join(", ")}`);
  const ui = strip(read("src/ui/ui.css"));
  const frames = ui.match(/@keyframes ui-fade\s*\{([\s\S]*?\})\s*\}/);
  assert.ok(frames, "ui-fade lives in ui/ui.css");
  const props = new Set([...frames[1].matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1]));
  assert.deepEqual([...props], ["opacity"], "ui-fade animates opacity only");
  // every animation in every stylesheet is ui-fade (or none), and never longer than 150 ms; the wipe and the draw are
  // only ever named through their tokens (tokens.css --motion-wipe, --motion-draw)
  for (const f of cssFiles) {
    for (const m of strip(read(f)).matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      if (/^none\b/.test(v) || /^var\(--motion-(wipe|draw)\)$/.test(v)) continue;
      assert.match(v, /\bui-fade\b/, `${f}: animation "${v}" is not the one fade`);
      const ms = [...v.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)].map((x) => Number(x[1]) * (x[2] === "s" ? 1000 : 1));
      if (!ms.length) assert.match(v, /var\(--dur-(fast|fade)\)/, `${f}: "${v}" names a duration`);
      for (const d of ms) assert.ok(d <= 150, `${f}: "${v}" lasts ${d} ms`);
    }
  }
});

test("nothing decorative is left: no shimmer, word reveal, cursor overlay, drawn tick, tracer, glow, page transitions", () => {
  const all = codeFiles.map((f) => [f, read(f)]);
  for (const word of ["shimmer-text", "StreamText", "CursorOverlay", "DoneTick", "EdgeGlow", "DeskGlow", "startViewTransition", "view-transition-name", "\"w-in\"", "spring-in", "edge-glow", "voice-orb", "has-tracer"]) {
    const hits = all.filter(([, t]) => t.includes(word)).map(([f]) => f);
    assert.deepEqual(hits, [], `${word} still in ${hits.join(", ")}`);
  }
  for (const gone of ["src/Tracer.tsx", "src/pages/Motion.tsx", "src/motion/signature.css", "src/motion/tokens.css", "src/motion.css", "src/themes.css", "src/sunshine.css"]) {
    assert.ok(!existsSync(root + gone), `${gone} is deleted`);
  }
});

test("reduced motion turns the fades off, and the motion choice is on or off", () => {
  const ui = strip(read("src/ui/ui.css"));
  assert.match(ui, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  assert.match(ui, /:root\[data-motion="off"\][^{]*\{[^}]*animation: none/);
});

test("there is no Motion page: no /appearance/motion route and no link to it", () => {
  for (const f of codeFiles) assert.doesNotMatch(read(f), /\/appearance\/motion/, f);
  assert.doesNotMatch(read("src/pages/registry.ts"), /import\("\.\/Motion"\)/);
});

/* ------------------------------------------------------------------ type */

test("Bodoni Moda is gone: no font file, no dependency, no serif token", () => {
  for (const f of srcFiles) assert.doesNotMatch(read(f), /Bodoni/i, f);
  assert.doesNotMatch(read("package.json"), /bodoni/i);
  if (existsSync(root + "package-lock.json")) assert.doesNotMatch(read("package-lock.json"), /bodoni/i);
  for (const f of cssFiles) assert.doesNotMatch(strip(read(f)), /--font-serif|var\(--serif\)|--serif\s*:/, f);
});

test("the type scale is 10/11/12/13/14/15/16/20/28 with weights 400, 500, 600 and 800 for display; corners 0, no shadow", () => {
  const t = strip(read("src/tokens.css"));
  const sizes = [...t.matchAll(/--text-[a-z0-9-]+:\s*([\d.]+)px;/g)].map((m) => Number(m[1]));
  for (const s of sizes) assert.ok([10, 11, 12, 13, 14, 15, 16, 20, 28].includes(s), `type size ${s}px is off the scale`);
  for (const [k, v] of [["--weight-regular", "400"], ["--weight-medium", "500"], ["--weight-heading", "600"], ["--weight-display", "800"]]) assert.match(t, new RegExp(`${k}:\\s*${v};`));
  assert.match(t, /--radius-sm:\s*0;/);
  assert.match(t, /--radius-md:\s*0;/);
  assert.match(t, /--shadow-float:\s*none;/);
});

/* ------------------------------------------------------------------ themes */

const out = await build({ entryPoints: [root + "src/appearance.tsx"], bundle: true, format: "esm", platform: "node", write: false, external: ["react"] });
const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "appearance-v3.mjs", out.outputFiles[0].text);
const store = new Map();
globalThis.localStorage ??= { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window ??= { matchMedia: () => ({ matches: false }), dispatchEvent: () => true };
globalThis.document ??= { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } };
const ap = await import(pathToFileURL(dir + "appearance-v3.mjs").href);

test("appearance offers exactly Light, Dark, High contrast and Match my computer", () => {
  assert.deepEqual(ap.THEMES.map((t) => t.id), ["light", "dark", "contrast", "auto"]);
  assert.deepEqual(ap.THEMES.map((t) => t.label), ["Light", "Dark", "High contrast", "Match my computer"]);
});

test("a saved older theme is mapped on load", () => {
  const cases = { night: "dark", lamp: "dark", neon: "dark", cherry: "dark", contrast: "contrast", sunshine: "light", paper: "light",
    linen: "light", gallery: "light", studio: "light", purple: "light", dark: "dark", light: "light", auto: "auto" };
  for (const [saved, now] of Object.entries(cases)) {
    localStorage.setItem("wb-appearance", JSON.stringify({ theme: saved }));
    assert.equal(ap.readAppearance().theme, now, `${saved} -> ${now}`);
  }
  localStorage.removeItem("wb-appearance");
});

test("High contrast sets data-mode=contrast; the others set light or dark", () => {
  const el = { dataset: {}, style: { setProperty() {}, removeProperty() {} } };
  for (const [theme, mode] of [["light", "light"], ["dark", "dark"], ["contrast", "contrast"]]) {
    ap.applyTo(el, { ...ap.DEFAULTS, theme });
    assert.equal(el.dataset.mode, mode);
  }
});

/* ------------------------------------------------------------------ tokens */

const tokens = strip(read("src/tokens.css"));
function block(sel) {
  const at = tokens.indexOf(sel);
  assert.ok(at >= 0, `${sel} block in tokens.css`);
  const open = tokens.indexOf("{", at);
  const body = tokens.slice(open + 1, tokens.indexOf("}", open));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2].toLowerCase()]));
}
const light = block('html[data-mode="light"]');
const dark = block('html[data-mode="dark"]');
const contrast = { ...light, ...block('html[data-mode="contrast"]') };

test("the palette is the industrial one, value for value", () => {
  const want = {
    "--color-bg": ["#F2F2F0", "#111111"], "--color-surface": ["#FFFFFF", "#1A1A1A"], "--color-surface-raised": ["#FFFFFF", "#1A1A1A"],
    "--color-surface-sunken": ["#EDEDEA", "#0B0B0B"], "--color-surface-muted": ["#EDEDEA", "#222222"], "--color-border": ["#D8D8D5", "#2B2B2B"],
    "--color-border-strong": ["#7A7A76", "#6B6B67"], "--color-ink": ["#111111", "#F2F2F0"], "--color-ink-soft": ["#2B2B2B", "#D4D4D0"],
    "--color-ink-muted": ["#5A5A57", "#A3A3A0"], "--color-ink-faint": ["#858581", "#75756F"],
    "--color-primary": ["#111111", "#F2F2F0"], "--color-on-primary": ["#FFFFFF", "#111111"], "--color-accent": ["#FF4D00", "#FF4D00"],
    "--color-accent-text": ["#B23800", "#FF4D00"], "--color-accent-soft": ["#EDEDEA", "#222222"], "--color-success": ["#2F7D4F", "#5FBF85"],
    "--color-success-text": ["#1E5A37", "#8FD8AB"], "--color-warning": ["#A85F06", "#E3A82B"], "--color-warning-text": ["#7A4300", "#F0C870"],
    "--color-danger": ["#B3372B", "#E5735F"], "--color-danger-text": ["#82231A", "#F2A193"], "--color-code-bg": ["#EDEDEA", "#0B0B0B"],
  };
  for (const [k, [l, d]] of Object.entries(want)) {
    assert.equal(light[k], l.toLowerCase(), `${k} light`);
    assert.equal(dark[k], d.toLowerCase(), `${k} dark`);
  }
});

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("every text token is AA (4.5:1) on bg, surface and accent-soft, in light, dark and high contrast", () => {
  const fgs = ["--color-ink", "--color-ink-muted", "--color-accent-text", "--color-success-text", "--color-warning-text", "--color-danger-text"];
  for (const [name, t] of [["light", light], ["dark", dark], ["contrast", contrast]]) {
    for (const fg of fgs) {
      for (const bg of ["--color-bg", "--color-surface", "--color-surface-raised", "--color-accent-soft"]) {
        assert.ok(t[fg] && t[bg], `${name}: ${fg} and ${bg} defined`);
        const r = ratio(t[fg], t[bg]);
        assert.ok(r >= 4.5, `${name}: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
      }
    }
    assert.ok(ratio(t["--color-on-primary"], t["--color-primary"]) >= 4.5, `${name}: the primary button`);
    assert.ok(ratio(t["--color-on-primary-hover"], t["--color-primary-hover"]) >= 4.5, `${name}: the primary button on hover (ink on orange)`);
    assert.ok(ratio(t["--color-on-accent"], t["--color-accent"]) >= 4.5, `${name}: words on an orange fill`);
    // the ring is 3:1 against the page by itself, or its ink halo is (and the orange is 3:1 on the halo)
    const ring = ratio(t["--color-focus"], t["--color-bg"]) >= 3 || (ratio(t["--color-focus-halo"], t["--color-bg"]) >= 3 && ratio(t["--color-focus"], t["--color-focus-halo"]) >= 3);
    assert.ok(ring, `${name}: the focus ring, orange on its halo`);
  }
  assert.equal(contrast["--color-ink"], "#000000", "High contrast is black text");
  assert.match(tokens, /html\[data-mode="contrast"\][^{]*\{[^}]*--border-w:\s*2px/, "High contrast draws 2 px borders");
  assert.match(tokens, /html\[data-mode="contrast"\][^{]*\{[^}]*--focus-w:\s*3px/, "and a 3 px focus ring");
});

test("the terminal's dark screen is AA in every theme: one --screen block, ink on its background", () => {
  const raw = strip(read("src/tokens.css"));
  const blocks = [...raw.matchAll(/([^{}]+)\{([^}]*--screen-bg:[^}]*)\}/g)];
  assert.equal(blocks.length, 1, "the --screen colours are defined once, the same in light, dark and high contrast");
  const t = Object.fromEntries([...blocks[0][2].matchAll(/(--screen-[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2].toLowerCase()]));
  const r = ratio(t["--screen-ink"], t["--screen-bg"]);
  assert.ok(r >= 4.5, `--screen-ink on --screen-bg is ${r.toFixed(2)}:1`);
  assert.ok(ratio(t["--screen-ink"], t["--screen-chrome"]) >= 4.5, "the chrome bar's words too");
});

test("cards and panels have no shadow; one floating shadow for menus, sheets, the palette and toasts", () => {
  const ui = strip(read("src/ui/ui.css"));
  const card = ui.match(/\.ui-card\s*\{([^}]*)\}/);
  assert.ok(card);
  assert.doesNotMatch(card[1], /box-shadow:\s*(?!none)\S/);
  for (const f of cssFiles) {
    for (const m of strip(read(f)).matchAll(/box-shadow:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      assert.ok(!/var\(--shadow-[1-4]\)/.test(v), `${f}: old shadow scale ${v}`);
    }
  }
  assert.match(ui, /\.ui-btn-primary\s*\{[^}]*background:\s*var\(--color-primary\)/, "the primary button is ink, not the accent");
});

test("the missing primitives exist: Page, Section, Textarea, Menu, List and Row, Loading, ErrorState", () => {
  const ui = read("src/ui/index.tsx");
  for (const p of ["Page", "Section", "Textarea", "Menu", "List", "Row", "Loading", "ErrorState"]) {
    assert.match(ui, new RegExp(`export (function|const) ${p}\\b`), p);
  }
});
