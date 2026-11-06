// The Workroom sweep (docs/design/0003-workroom.md, package F4): one reduced-motion rule, the two breakpoints from
// the brief, one main landmark, the dead files gone, syntax colours from tokens, and theme cards that preview the
// shell people actually see. Regex guards on the source, like the other shell tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const exists = (p) => existsSync(new URL(p, import.meta.url));

function walk(dir, ext, acc = []) {
  for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, ext, acc);
    else if (ext.some((e) => entry.name.endsWith(e))) acc.push(rel);
  }
  return acc.sort();
}
const cssFiles = walk("src", [".css"]);
const tsxFiles = walk("src", [".tsx", ".ts"]);

test("the OS reduced-motion setting is honoured by one rule, and Appearance turns motion off for it", () => {
  const where = cssFiles.filter((f) => /prefers-reduced-motion/.test(strip(read(`../${f}`))));
  assert.deepEqual(where, ["src/motion/tokens.css"], "prefers-reduced-motion appears in motion/tokens.css and nowhere else");
  const tokens = strip(read("../src/motion/tokens.css"));
  assert.equal((tokens.match(/@media \(prefers-reduced-motion: reduce\)/g) || []).length, 1, "one blanket rule");
  assert.match(tokens, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{[^}]*animation-duration: 1ms !important/);
  // the still states are written once, against data-motion="off"; Appearance sets that for the OS setting too
  const appearance = read("../src/appearance.tsx");
  assert.match(appearance, /prefers-reduced-motion: reduce/, "applyTo reads the OS setting");
  assert.match(appearance, /dataset\.motion = [^;]*\? "off"/, "data-motion is off when the OS asks for less");
  assert.match(appearance, /prefers-reduced-motion[^;]*;\s*[\s\S]{0,400}addEventListener/, "and follows the setting while the app is open");
});

test("the only breakpoints are the two from the brief: 900px (narrow) and 1280px (wide)", () => {
  const allowed = new Set([900, 901, 1280, 1281]);
  for (const f of cssFiles) {
    const css = strip(read(`../${f}`));
    for (const m of css.matchAll(/@media[^{]*?\((?:min|max)-width:\s*([\d.]+)px\)/g)) {
      assert.ok(allowed.has(Number(m[1])), `${f}: @media width ${m[1]}px is not --bp-narrow (900) or --bp-wide (1280)`);
    }
  }
  const tokens = read("../src/tokens.css");
  assert.match(tokens, /--bp-narrow:\s*900px/);
  assert.match(tokens, /--bp-wide:\s*1280px/);
  const bp = read("../src/shell/breakpoints.ts");
  assert.match(bp, /900/);
  assert.match(bp, /1280/);
});

test("one main landmark: the shell's; the teammates pages are sections inside it", () => {
  const mains = tsxFiles.filter((f) => /<main\b/.test(read(`../${f}`)));
  assert.deepEqual(mains, ["src/App.tsx"], "only the shell renders <main>");
  for (const f of ["../src/teammates/Teammates.tsx", "../src/teammates/Groups.tsx", "../src/teammates/Pages.tsx"]) {
    const src = read(f);
    assert.doesNotMatch(src, /role="main"/, `${f}: no role=main either`);
    assert.match(src, /<section className="tm-chat"/, `${f}: the chat column is a section`);
  }
});

test("the dead files and copies are gone: theme shim, char-based stream, the second dictation, toast fallbacks", () => {
  assert.ok(!exists("../src/theme.tsx"), "theme.tsx (unused shim) is deleted");
  const util = read("../src/util.tsx");
  assert.doesNotMatch(util, /StreamingMarkdown/, "StreamText in motion/index.tsx is the one reveal");
  const motion = read("../src/motion/index.tsx");
  assert.doesNotMatch(motion, /useDictation|dictationSupported/, "DictateButton (voice/DictateButton.tsx) covers dictation");
  const page = read("../src/pages/Motion.tsx");
  assert.match(page, /DictateButton/, "the Motion page tries your voice through the one mic button");
  assert.doesNotMatch(page, /useDictation/);
  // {toast.node} is a no-op inside the shell (ToastHost is mounted once); only the ask bar, which has no shell, keeps it
  const withNode = tsxFiles.filter((f) => /\btoast\.node\b/.test(read(`../${f}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")));
  assert.deepEqual(withNode, ["src/pages/AskBar.tsx"], "no {toast.node} renders left inside the shell");
});

test("syntax colours are tokens with readable contrast in both modes", () => {
  const tokens = strip(read("../src/tokens.css"));
  const light = tokens.slice(tokens.indexOf('html[data-mode="light"]'), tokens.indexOf('html[data-mode="dark"]'));
  const dark = tokens.slice(tokens.indexOf('html[data-mode="dark"]'));
  for (const name of ["--color-code-keyword", "--color-code-string", "--color-code-number", "--color-code-title", "--color-code-type"]) {
    assert.match(light, new RegExp(`${name}:\\s*#[0-9a-f]{6};`, "i"), `${name} in Studio`);
    assert.match(dark, new RegExp(`${name}:\\s*#[0-9a-f]{6};`, "i"), `${name} in Lamp`);
  }
  const styles = strip(read("../src/styles.css"));
  assert.match(styles, /\.hljs-keyword[^{]*\{ color: var\(--color-code-keyword\); \}/);
  assert.match(styles, /\.hljs-string[^{]*\{ color: var\(--color-code-string\); \}/);
  assert.doesNotMatch(styles, /\[data-mode="dark"\] \.hljs-/, "the dark values live in the tokens, not in a second rule set");
});

// each theme card paints its mini shell with the theme's own tokens; this reads the palette files the same way the
// browser does and checks the swatches in appearance.tsx against them
function block(css, selector) {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `${selector} block`);
  const open = css.indexOf("{", i);
  return css.slice(open, css.indexOf("}", open));
}
function tokenOf(blockText, name) {
  const m = blockText.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\s*;`, "i"));
  assert.ok(m, `${name} in block`);
  return m[1].toLowerCase();
}

test("theme cards preview the Workroom shell in each theme's own colours", () => {
  const picker = read("../src/ThemePicker.tsx");
  for (const part of ["mini-rail", "mini-presence", "mini-thread", "mini-stage"]) assert.match(picker, new RegExp(part), `the mini draws the ${part}`);
  assert.doesNotMatch(picker, /className="side"/, "no drawing of the old 256px sidebar");
  assert.match(picker, /Needs you|Plan my day/, "the mini shows the shell's own words");
  const tokens = strip(read("../src/tokens.css"));
  const themes = strip(read("../src/themes.css"));
  const sunshine = strip(read("../src/sunshine.css"));
  const source = {
    gallery: block(tokens, 'html[data-mode="light"]'),
    night: block(tokens, 'html[data-mode="dark"]'),
    sunshine: block(sunshine, ':root[data-theme="sunshine"]'),
    paper: block(themes, ':root[data-theme="paper"]'),
    cherry: block(themes, ':root[data-theme="cherry"]'),
    neon: block(themes, ':root[data-theme="neon"]'),
    contrast: block(themes, ':root[data-theme="contrast"]'),
  };
  const appearance = read("../src/appearance.tsx");
  const map = { paper: "--color-bg", panel: "--color-surface", text: "--color-ink", muted: "--color-ink-muted", accent: "--color-accent", onAccent: "--color-on-accent", border: "--color-border" };
  for (const [id, css] of Object.entries(source)) {
    const m = appearance.match(new RegExp(`id: "${id}"[\\s\\S]*?swatch: \\{([^}]*)\\}`));
    assert.ok(m, `swatch for ${id}`);
    const swatch = Object.fromEntries([...m[1].matchAll(/(\w+): "(#[0-9a-f]{6})"/gi)].map((x) => [x[1], x[2].toLowerCase()]));
    for (const [key, token] of Object.entries(map)) assert.equal(swatch[key], tokenOf(css, token), `${id}.${key} is ${token}`);
  }
  // the Appearance page's preview is made of the shell's own parts
  const page = read("../src/pages/Appearance.tsx");
  assert.match(page, /<Presence\b/, "the preview shows the presence strip");
  assert.match(page, /from "\.\.\/ui"/, "built from the primitives");
});
