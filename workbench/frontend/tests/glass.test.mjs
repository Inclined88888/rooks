// Glass navigation (docs/design/0003-workroom.md, section 6): frosted glass on the navigation layer only, a solid pill
// that slides to the current tab, readable in every theme, and a solid fallback for high contrast, reduced
// transparency and browsers without blur.
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
  return out;
}
const tokens = strip(read("src/tokens.css"));
function block(sel) {
  const at = tokens.indexOf(sel);
  assert.ok(at >= 0, sel);
  const open = tokens.indexOf("{", at);
  return tokens.slice(open + 1, tokens.indexOf("}", open));
}
const val = (body, name) => body.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
const THEMES = { light: 'html[data-mode="light"]', dark: 'html[data-mode="dark"]', contrast: 'html[data-mode="contrast"]' };
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("every theme defines the glass tokens", () => {
  for (const [name, sel] of Object.entries(THEMES)) {
    const b = block(sel);
    for (const t of ["--glass-bg", "--glass-bg-strong", "--glass-border", "--glass-edge", "--glass-shadow", "--glass-pill", "--glass-pill-ink", "--glass-pill-shadow", "--glass-filter"]) {
      assert.ok(val(b, t), `${name}: ${t}`);
    }
  }
});

test("the current tab's pill is AA in light, dark and high contrast", () => {
  for (const [name, sel] of Object.entries(THEMES)) {
    const b = block(sel);
    const r = ratio(val(b, "--glass-pill-ink"), val(b, "--glass-pill"));
    assert.ok(r >= 4.5, `${name}: pill ink on pill is ${r.toFixed(2)}:1`);
  }
});

test("high contrast, reduced transparency and no blur support all get a solid surface", () => {
  const c = block(THEMES.contrast);
  assert.equal(val(c, "--glass-filter"), "none", "high contrast: no blur");
  assert.match(val(c, "--glass-bg"), /^#[0-9a-f]{6}$/i, "high contrast: an opaque colour");
  assert.match(tokens, /@media \(prefers-reduced-transparency: reduce\)\s*\{[^}]*--glass-filter:\s*none/);
  assert.match(tokens, /@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
});

test("glass stays on the navigation layer: blur is only drawn by the shell", () => {
  const offenders = walk("src").filter((f) => f.endsWith(".css") && f !== "src/shell/shell.css" && f !== "src/tokens.css") // tokens.css only names it in the no-blur fallback
    .filter((f) => /backdrop-filter/.test(strip(read(f))));
  assert.deepEqual(offenders, [], "pages and cards stay solid");
  const shell = strip(read("src/shell/shell.css"));
  for (const m of shell.matchAll(/backdrop-filter:\s*([^;]+);/g)) assert.equal(m[1].trim(), "var(--glass-filter)", "blur comes from the token, so the fallbacks apply");
});

test("the top bar's pill slides to the current tab, and motion off stops it", () => {
  const rail = read("src/shell/Rail.tsx");
  assert.match(rail, /aria-label="Main"/);
  assert.match(rail, /className="rail-ind"/);
  assert.match(rail, /aria-current=\{on \? "page"/);
  assert.match(rail, /title=\{item\.label\}/, "icon-only tabs at 1280px and under keep a name on hover");
  const shell = strip(read("src/shell/shell.css"));
  assert.match(shell, /\.rail-ind \{[^}]*transition: transform var\(--dur-slide\)/);
  assert.match(strip(read("src/ui/ui.css")), /:root\[data-motion="off"\] \*[^{]*\{[^}]*transition: none !important/, "motion off (and the OS reduce motion setting) stops the slide");
});

test("More is a glass menu with a focus trap on desktop and a sheet on phones", () => {
  const more = read("src/shell/MoreSheet.tsx");
  assert.match(more, /useFocusTrap\(ref, open, onClose\)/);
  assert.match(more, /className="more-pop glass-menu"/);
  assert.match(more, /if \(narrow\) return <Sheet/);
});
