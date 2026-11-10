// The industrial redesign, review fixes (CHANGELOG "Unreleased · Industrial redesign", review). A reviewer drove every
// page in light, dark and high contrast and found these; each test here failed on the tree before the fixes
// (scratchpad industrial/review-fixes/fail-first.txt).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const css = (p) => strip(read(p));
const cssFiles = (dir) => readdirSync(root + dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : []));
const ALL = cssFiles("src");

/** [selector, body] of every innermost rule in a stylesheet. */
const rules = (text) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, " "), m[2]]);
/** The body of the first rule whose whole selector list is `sel`. */
function body(text, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`(?:^|[{}])\\s*${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `a rule for ${sel}`);
  return m[1];
}

/* ---------------------------------------------------------------- the focus ring */

test("a state drawn as an outline never replaces the focus ring (the active Chat/Code tab lost it)", () => {
  // the outline is the ring (tokens.css :focus-visible): a rule without :focus that sets one wins over it on that
  // element. Allowed: states of things that cannot take focus or are being dragged over, and the selected day, whose
  // own :focus-visible rule comes after it and draws the orange ring
  const ALLOWED = [".composer.drop-target", ".day-swatch input:checked + .day-swatch-mark", ".terminal-tab.is-over", ".day-cell.is-selected"];
  const bad = [];
  for (const f of ALL) {
    for (const [sel, b] of rules(css(f))) {
      const m = b.match(/(?:^|;|\s)outline\s*:\s*([^;]+)/);
      if (!m || /:focus/.test(sel) || /^(none|0)$/.test(m[1].trim())) continue;
      if (!sel.split(",").every((s) => ALLOWED.includes(s.trim()))) bad.push(`${f}: ${sel} { outline: ${m[1].trim()} }`);
    }
  }
  assert.deepEqual(bad, []);
  const day = css("src/pages/day/day.css");
  assert.match(body(day, ".day-cell:focus-visible"), /outline:\s*var\(--focus-w\) solid var\(--color-focus\)/, "the selected day shows the orange ring when focused");
  assert.ok(day.indexOf(".day-cell:focus-visible") > day.indexOf(".day-cell.is-selected"), "after the selected rule, so it wins");
});

test("no control cancels the ring's ink halo (orange alone is 2.97:1 on the paper)", () => {
  const CONTROL = /(\.btn|\.input|\.ui-input|\.ui-select|\.ui-btn|\.tab|\.chat-suggestion|\.pk-item|\bselect|\bbutton)\b[^ >+~]*$/;
  const ALLOWED = [".palette-input input:focus-visible"]; // the palette's box draws an orange rule under it instead
  const bad = [];
  for (const f of ALL) {
    for (const [sel, b] of rules(css(f))) {
      if (!/box-shadow\s*:\s*none/.test(b)) continue;
      for (const s of sel.split(",").map((x) => x.trim())) {
        if (CONTROL.test(s) && !/:disabled/.test(s) && !ALLOWED.includes(s)) bad.push(`${f}: ${s}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  const styles = css("src/styles.css");
  assert.match(styles, /\.input:focus-visible[^{]*\{[^}]*box-shadow:\s*var\(--focus-ring\)/, "a focused field keeps the halo");
  assert.match(body(css("src/chat/chat.css"), ".chat-chip-select select.input:focus-visible"), /outline:\s*var\(--focus-w\) solid var\(--color-focus\)[^}]*box-shadow:\s*var\(--focus-ring\)/, "the model chip: the same ring");
});

test("the Home ask field shows the orange ring when focused (its frame was ink at rest and on focus)", () => {
  const day = css("src/pages/day/day.css");
  assert.match(body(day, ".day-home-ask:focus-within"), /outline:\s*var\(--focus-w\) solid var\(--color-focus\)[^}]*box-shadow:\s*var\(--focus-ring\)/);
});

/* ---------------------------------------------------------------- data visuals */

function lum(hex) {
  const h = hex.replace("#", "");
  const ch = (i) => { const x = parseInt(h.slice(i, i + 2), 16) / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Each theme's custom properties, the way the browser resolves them: :root and light, then the theme on top. */
function theme(name) {
  const blocks = {};
  for (const [sel, b] of rules(strip(read("src/tokens.css")))) {
    for (const s of sel.split(",").map((x) => x.trim())) {
      blocks[s] ??= {};
      for (const m of b.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) blocks[s][m[1]] = m[2].trim();
    }
  }
  let v = { ...blocks[":root"], ...blocks['html[data-mode="light"]'], ...(name === "light" ? {} : blocks[`html[data-mode="${name}"]`]) };
  for (let i = 0; i < 4; i++) v = Object.fromEntries(Object.entries(v).map(([k, x]) => { const m = x.match(/^var\((--[\w-]+)\)$/); return [k, m && v[m[1]] ? v[m[1]] : x]; }));
  return v;
}

test("six chart series that can be told apart: each 3:1 on the card, every pair 1.25:1 apart in lightness", () => {
  for (const t of ["light", "dark", "contrast"]) {
    const v = theme(t);
    const series = [1, 2, 3, 4, 5, 6].map((i) => v[`--color-chart-${i}`]);
    series.forEach((c, i) => assert.match(c ?? "", /^#[0-9A-Fa-f]{6}$/, `${t}: --color-chart-${i + 1} is a colour`));
    series.forEach((c, i) => assert.ok(ratio(c, v["--color-surface"]) >= 3, `${t}: chart-${i + 1} ${c} on the card`));
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
      const r = ratio(series[a], series[b]);
      assert.ok(r >= 1.25, `${t}: chart-${a + 1} ${series[a]} and chart-${b + 1} ${series[b]} are ${r.toFixed(2)}:1 apart (lightness, so it holds for colour blindness too)`);
    }
  }
  const live = read("src/v02/LiveBlocks.tsx");
  assert.match(live, /"--color-chart-6"/, "live charts read all six");
  const fallback = live.match(/return p\.length \? p : \[([^\]]*)\]/)?.[1] ?? "";
  assert.equal(new Set(fallback.match(/#[0-9A-Fa-f]{6}/g)).size, 6, "and fall back to six distinct colours");
});

test("mermaid pies: words on every slice are AA, slices apart in lightness, colours set once per theme", () => {
  for (const t of ["light", "dark", "contrast"]) {
    const v = theme(t);
    const ink = v["--color-pie-ink"];
    assert.match(ink ?? "", /^#[0-9A-Fa-f]{6}$/, `${t}: --color-pie-ink`);
    const fills = [1, 2, 3, 4, 5].map((i) => v[`--color-pie-${i}`]);
    fills.forEach((c, i) => assert.ok(ratio(ink, c) >= 4.5, `${t}: pie words on --color-pie-${i + 1} ${c}: ${ratio(ink, c).toFixed(2)}:1`));
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) assert.ok(ratio(fills[a], fills[b]) >= 1.25, `${t}: pie-${a + 1} and pie-${b + 1} apart`);
  }
  const util = read("src/util.tsx");
  assert.match(util, /pieSectionTextColor:\s*pieInk/, "the words on a slice are the pie ink");
  assert.match(util, /pieOpacity:\s*"1"/, "solid slices (mermaid's 0.7 blends them with the page)");
  assert.match(util, /\.legend rect \{ stroke: \$\{ink\}/, "outlined legend swatches");
  assert.doesNotMatch(util, /pie4:\s*line|pieSectionTextColor:\s*surface/);
  // mermaid.initialize runs once, and again only when the theme's colours change (it ran before every diagram)
  assert.match(util, /if \(key !== mermaidKey\)/);
});

/* ---------------------------------------------------------------- copy and markup */

test("Status keeps its Connections rows as they were (states are words, not numbers)", () => {
  const status = read("src/pages/Status.tsx");
  assert.match(status, /<SettingRow label="Models" help=\{`\$\{doctor\.models_connected\} connection/);
  assert.match(status, /<SettingRow label="Browser" help=\{doctor\.browser_ready \? "Ready" : "Off"\} \/>/);
  assert.match(status, /<SettingRow label="Mail" help=\{`\$\{doctor\.mail_accounts\} account\$\{[^`]*Docker is not required/);
  assert.doesNotMatch(status, /<Stat /);
});

test("a step read aloud is the words alone: the brackets of [STEP 1 OF 5] are hidden from screen readers", () => {
  const tsx = read("src/ui/index.tsx");
  const fn = tsx.match(/export function MicroLabel[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fn, /<span aria-hidden="true">\[<\/span>/);
  assert.match(fn, /<span aria-hidden="true">\]<\/span>/);
});

/* ---------------------------------------------------------------- micro-labels */

test("section labels read [01 // NAME] like every other micro-label, and Settings writes its place once", () => {
  const ui = css("src/ui/ui.css");
  assert.match(body(ui, ".ui-section-num::after"), /content:\s*"\[" counter\(ui-section, decimal-leading-zero\) " \/\/ " attr\(data-name\) "\]"/);
  assert.match(read("src/ui/index.tsx"), /<span className="micro ui-section-num" aria-hidden="true" data-name=\{title\} \/>/);
  // the side list's title carries the place ([08 // SETTINGS]); the page head beside it does not repeat it
  const nav = read("src/pages/settings/CategoryNav.tsx");
  assert.match(nav, /<p className="st-nav-title" aria-hidden="true"><MicroLabel n=\{mark\?\.n\} name=\{label\} \/><\/p>/);
  assert.match(css("src/pages/settings/settings.css"), /\.st-layout > \.ui-page > \.ui-page-head \.ui-page-meta > \.ui-micro \{\s*display:\s*none;?\s*\}/);
});

/* ---------------------------------------------------------------- hero, footer, missed controls */

test("a hero headline stays two lines on a wide window: each line on one row, sized to fit its column", () => {
  const tsx = read("src/ui/index.tsx");
  assert.match(tsx, /"--hl-ch": Math\.max\(a\.length, b\.length\)/, "the headline tells CSS its longest line");
  const ui = css("src/ui/ui.css");
  assert.match(ui, /@media \(min-width: 901px\) \{[^@]*\.hl-fit \.hl-line \{[^}]*white-space:\s*nowrap/);
  assert.match(ui, /p\.hl-fit \{[^}]*font-size:\s*min\(var\(--hl-max\b[^;]*?\), calc\(100cqi \/ \(var\(--hl-ch/);
  // the column each one fits: a size container
  assert.match(ui, /\.ui-page-head\.is-hero \.ui-page-titles \{[^}]*container-type:\s*inline-size/);
  assert.match(css("src/chat/chat.css"), /\.chat-empty \{[^}]*container-type:\s*inline-size/);
  assert.match(body(css("src/pages/settings/settings.css"), ".st-auth-head"), /container-type:\s*inline-size/);
});

test("the welcome and sign-in footer is a dark section with a giant low-opacity wordmark", () => {
  const settings = css("src/pages/settings/settings.css");
  const foot = body(settings, ".st-auth-foot");
  assert.match(foot, /background:\s*var\(--color-dark\)/);
  assert.match(foot, /color:\s*var\(--color-on-dark/);
  assert.match(foot, /font-family:\s*var\(--font-mono\)/);
  const mark = body(settings, ".st-auth-foot::after");
  assert.match(mark, /content:\s*attr\(data-mark\)\s*\/\s*""/, "the wordmark is decoration (no words for screen readers)");
  assert.match(read("src/pages/settings/AuthCard.tsx"), /<p className="st-auth-foot" data-mark=\{PRODUCT\}>/, "the product's own name");
  assert.match(mark, /opacity:\s*0\.0\d/);
});

test("missed controls: the chat model select is a mono uppercase chip; the Calendar's show-calendar tick is 44 px wide on touch", () => {
  const sel = body(css("src/chat/chat.css"), ".chat-chip-select select.input");
  assert.match(sel, /font-family:\s*var\(--font-mono\)/);
  assert.match(sel, /text-transform:\s*uppercase/);
  assert.match(css("src/pages/day/day.css"), /@media \(pointer: coarse\) \{[^@]*\.day-check \{[^}]*min-width:\s*var\(--touch\)/, "it was 32x44");
});
