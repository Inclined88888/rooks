// The industrial redesign, step 2 (CHANGELOG "Unreleased · Industrial redesign"): the primitives in src/ui (ui.css,
// index.tsx) and their older twins in styles.css (.btn, .input, .card-head, .badge, .tabs, .modal, .stat) take the
// spec's language: square, 1 px lines, no shadow, mono uppercase buttons and labels, the micro-label [01 // NAME] with
// its orange square, condensed uppercase titles, a blueprint grid behind empty states, 44 px targets on touch screens.
// Every test here failed on the tree before this step (scratchpad industrial/primitives/fail-first.txt).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const ui = strip(read("src/ui/ui.css"));
const styles = strip(read("src/styles.css"));
const tokens = strip(read("src/tokens.css"));
const tsx = read("src/ui/index.tsx");

/** The body of the first rule whose whole selector list is `sel` (outside or inside a media query). */
function body(css, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|[{}])\\s*${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `a rule for ${sel}`);
  return m[1];
}
/** Everything inside the first `@media <query> { ... }` block. */
function media(css, query) {
  const at = css.indexOf(`@media ${query}`);
  assert.ok(at >= 0, `@media ${query}`);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", at) + 1, i);
  }
  return "";
}

/* ---------------------------------------------------------------- buttons */

test("buttons: mono uppercase words; primary a black rectangle that hovers to orange with ink words; secondary a 1 px ink outline", () => {
  const base = body(ui, ".ui-btn");
  assert.match(base, /font-family:\s*var\(--font-mono\)/);
  assert.match(base, /text-transform:\s*uppercase/);
  assert.match(base, /letter-spacing:\s*var\(--tracking-button\)/);
  assert.match(base, /border:\s*var\(--border-w\) solid var\(--color-ink\)/, "the secondary (default) button has a black edge");
  assert.match(base, /background:\s*var\(--color-surface\)/, "on white");
  assert.match(body(ui, ".ui-btn-primary"), /background:\s*var\(--color-primary\);[^}]*color:\s*var\(--color-on-primary\)/);
  const hover = body(ui, ".ui-btn-primary:hover:not(:disabled)");
  assert.match(hover, /background:\s*var\(--color-primary-hover\)/, "orange");
  assert.match(hover, /color:\s*var\(--color-on-primary-hover\)/, "ink words on orange (white on #FF4D00 is 3.3:1)");
  assert.match(body(ui, ".ui-btn-ghost"), /border-color:\s*transparent/);
  assert.match(body(ui, ".ui-btn-danger"), /border-color:\s*var\(--color-danger\);[^}]*color:\s*var\(--color-danger-text\)/, "danger stays recognisable");
  // the older .btn class in styles.css is the same button
  const legacy = body(styles, ".btn");
  assert.match(legacy, /font-family:\s*var\(--font-mono\)/);
  assert.match(legacy, /text-transform:\s*uppercase/);
  assert.match(legacy, /border:\s*var\(--border-w\) solid var\(--color-ink\)/);
});

/* ---------------------------------------------------------------- inputs, selects, checkboxes, switches */

test("inputs and selects: square, the orange focus ring (never replaced by a thinner one), a chevron that is not a gradient", () => {
  assert.doesNotMatch(ui, /\.ui-input:focus-visible[^{]*\{[^}]*outline:/, "the global :focus-visible ring (orange on an ink halo) is not overridden");
  assert.match(body(ui, ".ui-input:focus-visible, .ui-select:focus-visible"), /border-color:\s*var\(--color-ink\)/);
  assert.match(body(ui, ".ui-select"), /background-image:\s*var\(--icon-chevron\)/, "the chevron is a token");
  assert.doesNotMatch(ui, /gradient\(/, "no gradient in ui.css");
  for (const mode of ['html[data-mode="light"]', 'html[data-mode="dark"]', 'html[data-mode="contrast"]']) {
    const at = tokens.indexOf(`${mode} {`) >= 0 ? tokens.indexOf(`${mode} {`) : tokens.indexOf(mode);
    const block = tokens.slice(tokens.indexOf("{", at) + 1, tokens.indexOf("}", at));
    assert.match(block, /--icon-chevron:\s*url\("data:image\/svg\+xml,/, `${mode} has a chevron in its ink`);
  }
  assert.match(body(styles, "select.input"), /background-image:\s*var\(--icon-chevron\)/, "the older select too");
  assert.doesNotMatch(styles, /9ca3af/i, "the old grey-blue chevron is gone");
});

test("checkboxes and radios are drawn square: ink when ticked, an orange square inside a picked radio", () => {
  const box = body(ui, 'input[type="checkbox"], input[type="radio"]');
  assert.match(box, /appearance:\s*none/);
  assert.match(box, /border-radius:\s*0/);
  assert.match(box, /border:\s*var\(--border-w\) solid var\(--color-border-strong\)/);
  assert.match(body(ui, 'input[type="checkbox"]:checked, input[type="checkbox"]:indeterminate'), /background:\s*var\(--color-primary\)/);
  assert.match(body(ui, 'input[type="radio"]::before'), /background:\s*var\(--color-accent\)/);
  assert.doesNotMatch(styles, /input\[type="checkbox"\][^{]*\{[^}]*accent-color/, "the native round-cornered box is not used");
  const settings = strip(read("src/pages/settings/settings.css"));
  assert.doesNotMatch(body(settings, ".st-switch-thumb"), /50%/, "the switch's thumb is a square");
});

/* ---------------------------------------------------------------- cards and the micro-label */

test("the micro-label reads [01 // NAME] beside an orange square, and is hidden from screen readers when it is decoration", () => {
  const m = tsx.match(/export function microText[\s\S]*?\n\}/);
  assert.ok(m, "microText formats the label");
  const microText = new Function(`${m[0].replace(/export /, "").replace(/: (number|string|undefined)( \| (number|string|undefined))*/g, "").replace(/\): string/, ")")}; return microText;`)();
  assert.equal(microText(1, "Usage"), "[01 // Usage]");
  assert.equal(microText(12, "Keys"), "[12 // Keys]");
  assert.equal(microText(undefined, "Keys"), "[Keys]");
  assert.match(tsx, /export function MicroLabel\(/);
  assert.match(tsx, /className=\{cx\("micro", "ui-micro"[^}]*\}[^>]*aria-hidden=\{decorative \|\| undefined\}/, "aria-hidden when decorative");
  assert.match(tsx, /decorative = true/, "decoration by default");
  assert.match(styles, /\.micro::before \{[^}]*background:\s*var\(--color-accent\)/, "the orange square (styles.css)");
});

test("cards: white, a 1 px line, no shadow; a mono label on top, a bold uppercase title and a thin divider inside", () => {
  const card = body(ui, ".ui-card");
  assert.match(card, /background:\s*var\(--color-surface\)/);
  assert.match(card, /border:\s*var\(--border-w\) solid var\(--color-border\)/);
  assert.doesNotMatch(card, /box-shadow:(?!\s*none)/);
  assert.match(body(ui, ".ui-card-head"), /border-bottom:\s*var\(--border-w\) solid var\(--color-border\)/, "the thin divider");
  const title = body(ui, ".ui-card-title");
  assert.match(title, /text-transform:\s*uppercase/);
  assert.match(title, /font-weight:\s*var\(--weight-(bold|display)\)/);
  assert.match(tsx, /export function Card\(\{[^)]*label[^)]*heading/, "Card takes a label and a heading");
  assert.match(tsx, /<MicroLabel n=\{index\} name=\{label\}/);
  assert.match(tsx, /<h3 className="ui-card-title">/);
  // the older card head in styles.css
  assert.match(body(styles, ".card-head h2"), /text-transform:\s*uppercase/);
});

/* ---------------------------------------------------------------- page and section heads */

test("page titles are the condensed display face; sections are numbered 01, 02 by a decorative mono label", () => {
  const title = body(ui, ".ui-page-title");
  assert.match(title, /font-family:\s*var\(--font-display\)/);
  assert.match(title, /text-transform:\s*uppercase/);
  assert.match(title, /font-size:\s*var\(--display-md\)/);
  assert.match(body(ui, ".ui-page-kicker"), /font-family:\s*var\(--font-mono\)/, "the kicker is a micro-label");
  assert.match(body(ui, ".ui-page"), /counter-reset:\s*ui-section/);
  assert.match(body(ui, ".ui-section"), /counter-increment:\s*ui-section/);
  assert.match(ui, /\.ui-section-num::after \{[^}]*content:\s*counter\(ui-section, decimal-leading-zero\)/);
  assert.match(tsx, /<span className="micro ui-section-num" aria-hidden="true" \/>/, "the number is decoration");
  assert.match(body(ui, ".ui-section-title"), /font-family:\s*var\(--font-display\)/);
});

/* ---------------------------------------------------------------- tables and lists */

test("tables and lists: hairline rows and mono column heads", () => {
  assert.match(body(ui, ".ui-table th"), /font-family:\s*var\(--font-mono\)[^}]*text-transform:\s*uppercase[^}]*letter-spacing:\s*var\(--tracking-micro\)/);
  assert.match(body(ui, ".ui-table th, .ui-table td"), /border-bottom:\s*var\(--border-w\) solid var\(--color-border\)/);
  assert.match(body(ui, ".ui-row"), /border-bottom:\s*var\(--border-w\) solid var\(--color-border\)/);
  assert.match(body(styles, ".prose th"), /font-family:\s*var\(--font-mono\)/, "tables in answers too (their words keep their case)");
});

/* ---------------------------------------------------------------- sheets, modals, menus, toasts */

test("sheets, modals, menus and toasts: square, a 1 px edge, no shadow, a dark scrim without blur", () => {
  for (const sel of [".ui-sheet", ".ui-menu-pop", ".ui-toast"]) {
    const b = body(ui, sel);
    assert.doesNotMatch(b, /box-shadow:(?!\s*none)/, `${sel} has no shadow`);
  }
  assert.match(body(ui, ".ui-sheet-left"), /border-right:\s*var\(--border-w\) solid var\(--color-ink\)/);
  assert.match(body(ui, ".ui-sheet-right"), /border-left:\s*var\(--border-w\) solid var\(--color-ink\)/);
  assert.match(body(ui, ".ui-toast"), /border:\s*var\(--border-w\) solid var\(--color-ink\)/);
  assert.doesNotMatch(body(ui, ".ui-toast-icon"), /50%/, "a square mark");
  assert.doesNotMatch(body(ui, ".ui-scrim"), /backdrop-filter/);
  assert.doesNotMatch(body(styles, ".modal"), /box-shadow:(?!\s*none)/);
  assert.match(body(styles, ".modal"), /border:\s*var\(--border-w\) solid var\(--color-ink\)/);
  const scrim = tokens.match(/--color-scrim:\s*rgba\(17, 17, 17, ([0-9.]+)\)/);
  assert.ok(scrim && Number(scrim[1]) >= 0.5, "the light scrim is dark enough to read as a scrim");
});

/* ---------------------------------------------------------------- tabs, badges, pills */

test("tabs: square, mono uppercase, the current one an ink block; badges and pills square with mono words; no inset shadows", () => {
  const tab = body(ui, ".ui-tab");
  assert.match(tab, /font-family:\s*var\(--font-mono\)/);
  assert.match(tab, /text-transform:\s*uppercase/);
  const on = body(ui, ".ui-tab.is-active");
  assert.match(on, /background:\s*var\(--color-primary\)/);
  assert.match(on, /color:\s*var\(--color-on-primary\)/);
  assert.doesNotMatch(ui, /box-shadow:\s*inset/, "lines are borders, not shadows");
  const badge = body(ui, ".ui-badge");
  assert.match(badge, /font-family:\s*var\(--font-mono\)/);
  assert.match(badge, /text-transform:\s*uppercase/);
  assert.doesNotMatch(body(ui, ".ui-badge-live::before"), /50%/, "the live mark is a small orange square");
  assert.match(body(styles, ".badge"), /font-family:\s*var\(--font-mono\)/);
  assert.match(body(styles, ".tab.active"), /background:\s*var\(--color-primary\)/);
  assert.doesNotMatch(ui, /border-radius:(?!\s*(?:0|var\(--radius))/, "every corner in ui.css is square");
});

/* ---------------------------------------------------------------- empty states and stats */

test("empty states sit on the blueprint grid with a big uppercase line and a mono hint", () => {
  const empty = body(ui, ".ui-empty");
  assert.match(empty, /background-image:\s*var\(--bg-grid\)/);
  assert.match(empty, /background-size:\s*var\(--bg-grid-size\)/);
  const title = body(ui, ".ui-empty-title");
  assert.match(title, /font-family:\s*var\(--font-display\)/);
  assert.match(title, /text-transform:\s*uppercase/);
  assert.match(body(ui, ".ui-empty-line"), /font-family:\s*var\(--font-mono\)/);
  assert.match(body(styles, ".empty-title"), /text-transform:\s*uppercase/, "the older empty state too");
});

test("stats: a huge number with a tiny mono label below it", () => {
  const value = body(ui, ".ui-stat-value");
  assert.match(value, /font-family:\s*var\(--font-display\)/);
  assert.match(value, /order:\s*-1/, "the number first, the label below (the label still comes first for a screen reader)");
  assert.match(body(ui, ".ui-stat-label"), /font-family:\s*var\(--font-mono\)[^}]*text-transform:\s*uppercase/);
});

/* ---------------------------------------------------------------- touch */

test("on touch screens the controls are 44 px targets", () => {
  const coarse = media(ui, "(pointer: coarse)");
  for (const sel of [".ui-btn", ".ui-iconbtn", ".ui-input", ".ui-select", ".ui-tab", ".ui-menu-item", ".ui-toast-x", ".ui-chip"]) {
    assert.match(coarse, new RegExp(`(^|[\\s,])${sel.replace(".", "\\.")}[\\s,{][^{]*\\{[^}]*min-height:\\s*var\\(--touch\\)`), `${sel} is 44 px tall`);
  }
  assert.match(coarse, /\.ui-iconbtn[^{]*\{[^}]*min-width:\s*var\(--touch\)/, "and an icon button 44 px wide");
});
