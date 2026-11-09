// The industrial redesign (CHANGELOG "Unreleased · Industrial redesign"): square corners, hairline borders instead of
// shadows, no gradients but the faint blueprint grid, one safety orange accent, and condensed uppercase headlines.
// Step 1 moved the tokens and the global CSS. Feature stylesheets follow in the next steps: each file that still has a
// round corner, a shadow or a gradient is named in a KNOWN list below, and the lists must shrink to empty by the
// sweep step. A file that is cleaned up must be taken off its list (the test fails until it is), and no new file may
// join one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
function walk(dir, out = []) {
  for (const n of readdirSync(root + dir)) {
    const p = `${dir}/${n}`;
    if (statSync(root + p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out.sort();
}
const srcFiles = walk("src");
const cssFiles = srcFiles.filter((f) => f.endsWith(".css"));
const tsxFiles = srcFiles.filter((f) => /\.tsx?$/.test(f));
const tokens = strip(read("src/tokens.css"));
const styles = strip(read("src/styles.css"));

// Every custom property declared anywhere, so var(--radius) -> var(--radius-md) -> 0 can be followed.
const props = new Map();
for (const f of cssFiles) {
  for (const m of strip(read(f)).matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    const [name, value] = [m[1], m[2].trim()];
    if (!props.has(name)) props.set(name, new Set());
    props.get(name).add(value);
  }
}
/** Every value a var() can take (any theme or alias), resolved to literals. */
function resolve(value, seen = new Set()) {
  const m = value.trim().match(/^var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)$/);
  if (!m) return [value.trim()];
  if (seen.has(m[1])) return [];
  seen.add(m[1]);
  const defs = props.get(m[1]);
  if (!defs) return m[2] ? resolve(m[2], seen) : [`undefined ${m[1]}`];
  return [...defs].flatMap((d) => resolve(d, seen));
}
const isZero = (v) => /^(0|0px|0%|inherit|initial|unset)$/.test(v);
const radiusOk = (value) => value.split(/\s+(?![^(]*\))/).every((part) => resolve(part).every(isZero));

/** CSS rules as [selector, body] pairs (media query wrappers flattened). */
function rules(css) {
  return [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
}

function offenders(check) {
  const out = new Set();
  for (const f of cssFiles) if (check(strip(read(f)), f)) out.add(f);
  return [...out].sort();
}

/* ---------------------------------------------------------------- shape */

// Feature stylesheets with a literal corner that is not 0 (the ones that read --radius-* are square already); they
// move to square corners in the next steps.
const KNOWN_ROUND = [
  "src/appearance.css", "src/chat/chat.css", "src/connect.css", "src/packs/packs.css", "src/pages/agents/agents.css", "src/pages/day/day.css",
  "src/pages/settings/settings.css", "src/shell/shell.css", "src/skills.css", "src/team/team.css", "src/teammates/teammates.css",
  "src/ui/ui.css", "src/v02/v02.css", "src/voice/voice.css",
].sort();

test("the radius tokens are all 0, and every border-radius in the global CSS resolves to 0", () => {
  for (const t of ["--radius-xs", "--radius-sm", "--radius-md", "--radius-lg", "--radius-full"]) {
    assert.match(tokens, new RegExp(`${t}:\\s*0;`), `${t} is 0`);
  }
  for (const f of ["src/tokens.css", "src/styles.css", "src/fonts.css"]) {
    for (const m of strip(read(f)).matchAll(/border-radius\s*:\s*([^;}]+)/g)) assert.ok(radiusOk(m[1]), `${f}: border-radius ${m[1].trim()}`);
  }
});

test("round corners are left only in the feature stylesheets still waiting for their step (the list only shrinks)", () => {
  const found = offenders((css) => [...css.matchAll(/border-radius\s*:\s*([^;}]+)/g)].some((m) => !radiusOk(m[1])));
  assert.deepEqual(found, KNOWN_ROUND, "a file left the list (take it off KNOWN_ROUND) or a new round corner appeared");
  const inline = tsxFiles.filter((f) => /borderRadius\s*:\s*(?!0\b)/.test(read(f)));
  assert.deepEqual(inline, ["src/util.tsx"], "inline round corners: only the skeleton avatar, until the sweep step");
});

/* ---------------------------------------------------------------- shadows */

// A box-shadow is allowed only as none, or as the focus ring: in a :focus rule, or the --focus-ring token.
const KNOWN_SHADOW = [
  "src/appearance.css", "src/attachments.css", "src/packs/packs.css", "src/pages/day/day.css", "src/room/room.css", "src/shell/shell.css",
  "src/team/team.css", "src/ui/ui.css", "src/voice/voice.css", "src/work.css",
].sort();
function badShadows(css) {
  const bad = [];
  for (const [sel, body] of rules(css)) {
    for (const m of body.matchAll(/(?:^|;|\s)(box-shadow|--[\w-]*shadow[\w-]*)\s*:\s*([^;]+)/g)) {
      const v = m[2].trim();
      if (/^(none|var\(--focus-ring\))$/.test(v) || resolve(v).every((x) => x === "none")) continue;
      if (/:focus/.test(sel) || m[1] === "--focus-ring") continue;
      bad.push(`${sel} { ${m[1]}: ${v} }`);
    }
  }
  return bad;
}

test("the shadow tokens are none, and the global CSS draws no shadow but the focus ring", () => {
  for (const t of ["--shadow-float", "--glass-shadow", "--glass-pill-shadow"]) {
    for (const v of resolve(`var(${t})`)) assert.equal(v, "none", `${t} is none`);
  }
  assert.match(tokens, /--focus-ring:\s*0 0 0 1px var\(--color-focus-halo\)/, "the focus ring: an orange outline on a 1 px ink halo");
  assert.deepEqual(badShadows(tokens), [], "tokens.css");
  assert.deepEqual(badShadows(styles), [], "styles.css");
});

test("shadows are left only in the feature stylesheets still waiting for their step (the list only shrinks)", () => {
  assert.deepEqual(offenders((css) => badShadows(css).length > 0), KNOWN_SHADOW);
  assert.deepEqual(tsxFiles.filter((f) => /boxShadow\s*:/.test(read(f))), [], "no inline shadows");
});

/* ---------------------------------------------------------------- gradients */

// a hard-stop divider line in the day page and the select chevron in ui.css: drawn another way in their steps
const KNOWN_GRADIENT = ["src/pages/day/day.css", "src/ui/ui.css"].sort();
const GRADIENT = /(linear|radial|conic)-gradient\(/;

test("the only gradient is the blueprint grid token: a faint 1 px grid in the line colour", () => {
  const decls = [...tokens.matchAll(/(--[\w-]+)\s*:\s*([^;]*gradient\([^;]*);/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(decls)], ["--bg-grid"], "tokens.css spells a gradient only in --bg-grid");
  const grid = tokens.match(/--bg-grid:\s*([^;]+);/)[1];
  assert.match(grid, /linear-gradient\(to right, var\(--color-grid\) 1px, transparent 1px\)/, "vertical 1 px lines");
  assert.match(grid, /linear-gradient\(to bottom, var\(--color-grid\) 1px, transparent 1px\)/, "horizontal 1 px lines");
  assert.match(tokens, /--bg-grid-size:\s*\d+px \d+px;/);
  for (const v of resolve("var(--color-grid)")) assert.match(v, /^color-mix\(in srgb, var\(--color-border\) \d{1,2}%, transparent\)$/, "the line colour at low opacity");
  assert.doesNotMatch(styles, GRADIENT, "styles.css paints no gradient");
  assert.deepEqual(offenders((css, f) => f !== "src/tokens.css" && GRADIENT.test(css)), KNOWN_GRADIENT, "no gradients outside --bg-grid");
  assert.deepEqual(tsxFiles.filter((f) => GRADIENT.test(read(f))), [], "no inline gradients");
});

/* ---------------------------------------------------------------- colour */

function block(sel) {
  const at = tokens.indexOf(sel);
  assert.ok(at >= 0, sel);
  const open = tokens.indexOf("{", at);
  return Object.fromEntries([...tokens.slice(open + 1, tokens.indexOf("}", open)).matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2].toUpperCase()]));
}

test("the palette is the spec's: off-white, white, ink, hairlines and one safety orange", () => {
  const light = block('html[data-mode="light"]');
  const want = { "--color-bg": "#F2F2F0", "--color-surface": "#FFFFFF", "--color-surface-muted": "#EDEDEA", "--color-ink": "#111111",
    "--color-ink-soft": "#2B2B2B", "--color-border": "#D8D8D5", "--color-accent": "#FF4D00", "--color-primary": "#111111" };
  for (const [k, v] of Object.entries(want)) assert.equal(light[k], v, `light ${k}`);
  const dark = block('html[data-mode="dark"]');
  const wantDark = { "--color-bg": "#111111", "--color-surface": "#1A1A1A", "--color-border": "#2B2B2B", "--color-ink": "#F2F2F0", "--color-accent": "#FF4D00" };
  for (const [k, v] of Object.entries(wantDark)) assert.equal(dark[k], v, `dark ${k}`);
  assert.equal(block('html[data-mode="contrast"]')["--color-accent"], "#FF4D00", "high contrast keeps the same orange");
  assert.match(tokens, /--color-dark:\s*#1A1A1A;/i, "the dark section colour");
  // the primary button hovers to orange with ink words (white on #FF4D00 is 3.3:1, under AA)
  assert.equal(light["--color-primary-hover"], "#FF4D00");
  assert.equal(light["--color-on-primary-hover"], "#111111");
  // no blue or purple anywhere in the palette (hue 180-300 with real saturation)
  for (const m of tokens.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < 0.12) continue;
    const h = max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
    assert.ok(!(h * 60 > 180 && h * 60 < 300), `#${m[1]} is blue or purple`);
  }
});

/* ---------------------------------------------------------------- type */

test("headlines are the condensed display face, extra bold and uppercase; body is Inter at 15 px; micro-labels are mono 10-11 px at 0.12em", () => {
  assert.match(tokens, /--font-display:\s*"Archivo Variable"/);
  assert.match(tokens, /--font-sans:\s*"Inter Variable"/);
  assert.match(tokens, /--font-mono:\s*"JetBrains Mono Variable"/);
  assert.match(tokens, /--weight-display:\s*800;/);
  assert.match(tokens, /--stretch-display:\s*\d+%;/);
  for (const t of ["--display-xl", "--display-lg", "--display-md"]) assert.match(tokens, new RegExp(`${t}:\\s*clamp\\(`), `${t} scales down on phones`);
  assert.match(tokens, /--text-body:\s*15px;/);
  assert.match(tokens, /--text-micro:\s*11px;/);
  assert.match(tokens, /--text-micro-sm:\s*10px;/);
  assert.match(tokens, /--tracking-micro:\s*0\.12em;/);
  const h = styles.match(/h1, h2 \{([^}]*)\}/);
  assert.ok(h, "one rule for the headlines");
  assert.match(h[1], /font-family:\s*var\(--font-display\)/);
  assert.match(h[1], /text-transform:\s*uppercase/);
  assert.match(h[1], /font-weight:\s*var\(--weight-display\)/);
  assert.match(h[1], /font-stretch:\s*var\(--stretch-display\)/);
  assert.match(styles, /body \{[^}]*font:\s*var\(--text-body\)/, "body text is 15 px");
  assert.match(styles, /\.micro \{[^}]*font-family:\s*var\(--font-mono\)[^}]*text-transform:\s*uppercase[^}]*letter-spacing:\s*var\(--tracking-micro\)/, "the micro-label");
  assert.match(styles, /\.micro::before \{[^}]*background:\s*var\(--color-accent\)/, "always with a small orange square");
});

test("the fonts are bundled: Archivo with its width axis, Inter and JetBrains Mono, exact versions, nothing from the internet", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const name of ["@fontsource-variable/archivo", "@fontsource-variable/inter", "@fontsource-variable/jetbrains-mono"]) {
    assert.match(pkg.dependencies[name] || "", /^\d+\.\d+\.\d+$/, `${name} pinned to an exact version`);
  }
  const fonts = strip(read("src/fonts.css"));
  assert.match(fonts, /font-family: "Archivo Variable";[^}]*font-stretch: 62% 125%;[^}]*archivo-latin-wdth-normal\.woff2/, "Archivo with the width axis");
  assert.match(fonts, /font-family: "Inter Variable";[^}]*inter-latin-wght-normal\.woff2/);
  assert.match(fonts, /font-family: "JetBrains Mono Variable"/);
  assert.doesNotMatch(fonts, /https?:|\/\//, "no font from the internet");
  assert.doesNotMatch(read("index.html"), /fonts\.googleapis|fonts\.gstatic/);
});

/* ---------------------------------------------------------------- globals */

test("the global CSS: focus ring in the accent, orange selection marks, links in ink with an orange rule", () => {
  assert.match(tokens, /:focus-visible \{[^}]*outline:\s*var\(--focus-w\) solid var\(--color-focus\)[^}]*box-shadow:\s*var\(--focus-ring\)/);
  assert.match(tokens, /--color-focus:\s*#FF4D00;/i);
  assert.match(tokens, /::selection \{[^}]*background:\s*var\(--color-accent\)[^}]*color:\s*var\(--color-on-accent\)/);
  assert.match(styles, /a \{[^}]*color:\s*var\(--text\)[^}]*text-decoration-color:\s*var\(--color-accent\)/);
  assert.match(styles, /\.blueprint \{[^}]*background-image:\s*var\(--bg-grid\)[^}]*background-size:\s*var\(--bg-grid-size\)/, "the blueprint grid for hero and empty areas");
});

/* ---------------------------------------------------------------- motion */

test("motion: an orange wipe for headlines and a line that draws in, both off under reduced motion and Motion off", () => {
  assert.match(tokens, /--motion-wipe:\s*ui-wipe var\(--dur-reveal\) var\(--ease-industrial\)/);
  assert.match(tokens, /--motion-draw:\s*ui-draw var\(--dur-reveal\) var\(--ease-industrial\)/);
  assert.match(tokens, /--ease-industrial:\s*cubic-bezier\(/);
  assert.doesNotMatch(tokens, /--ease[\w-]*:\s*cubic-bezier\([^)]*(?:-|1\.[0-9])/, "no overshoot, no bounce");
  const ui = strip(read("src/ui/ui.css"));
  const wipe = ui.match(/@keyframes ui-wipe \{((?:\s*[\d.%, a-z]+\{[^{}]*\})+)\s*\}/);
  assert.ok(wipe, "ui-wipe lives in ui/ui.css beside the fade");
  assert.match(wipe[1], /transform: scaleX\(1\)/, "the orange bar wipes across");
  assert.match(wipe[1], /100% \{[^}]*transform: scaleX\(0\)/, "and leaves nothing behind");
  assert.doesNotMatch(wipe[1], /opacity|scale\(|rotate|scaleX\(1\.[0-9]/, "a wipe, not a bounce or a fade");
  assert.match(ui, /@keyframes ui-draw \{ from \{ transform: scaleX\(0\); \} to \{ transform: scaleX\(1\); \} \}/, "the line draws in");
  assert.match(styles, /\.reveal::after \{[^}]*background:\s*var\(--color-accent\)[^}]*animation:\s*var\(--motion-wipe\)/);
  assert.match(styles, /\.rule-draw \{[^}]*animation:\s*var\(--motion-draw\)/);
  // the one reduced-motion rule (ui/ui.css) and Motion off already stop every animation
  assert.match(ui, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{[^}]*animation: none !important/);
  assert.match(ui, /:root\[data-motion="off"\][^{]*\{[^}]*animation: none/);
  assert.match(styles, /\.reveal::after \{[^}]*transform: scaleX\(0\)/, "at rest (and with motion off) the bar is gone, so nothing covers the words");
});
