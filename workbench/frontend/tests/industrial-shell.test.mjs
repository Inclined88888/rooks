// The industrial redesign, step 3 (CHANGELOG "Unreleased · Industrial redesign"): the shell and the page frame. The
// top bar is paper with a 1 px edge, a small mark, small uppercase mono links in hairline cells, a thin orange rule
// under the current one and one black rectangular call to action (search); menus, More and the command menu are square
// with an ink edge and micro-labels; the phone bar is docked flush with a 1 px top edge and 44 px cells. Pages get the
// header pattern (a left meta column with the place's number and a mono label, the content on the right; stacked on
// phones), and the welcome, the sign-in and Home are heroes: a huge two-line uppercase headline with an offset second
// line, a mono intro on the left, the existing card framed in a 1 px border on the right, one orange accent.
// Every test here failed on the tree before this step (scratchpad industrial/shell/fail-first.txt).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const shell = existsSync(root + "src/shell/shell.css") ? strip(read("src/shell/shell.css")) : "";
const ui = strip(read("src/ui/ui.css"));
const styles = strip(read("src/styles.css"));
const settings = strip(read("src/pages/settings/settings.css"));
const day = strip(read("src/pages/day/day.css"));

async function load(rel, name) {
  if (!existsSync(root + rel)) return null;
  const out = await build({ entryPoints: [root + rel], bundle: true, format: "esm", platform: "node", write: false });
  const dir = root + "node_modules/.cache/wb-tests/";
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}
const headline = await load("src/ui/headline.ts", "industrial-headline.mjs");
const places = await load("src/pages/places.ts", "industrial-places.mjs");

/** The body of the first rule whose whole selector list is `sel` (outside or inside a media query). */
function body(css, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|[{}])\\s*${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `a rule for ${sel}`);
  return m[1];
}
/** Everything inside every `@media <query> { ... }` block, joined. */
function media(css, query) {
  let out = "";
  for (let at = css.indexOf(`@media ${query}`); at >= 0; at = css.indexOf(`@media ${query}`, at + 1)) {
    let depth = 0;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { out += css.slice(css.indexOf("{", at) + 1, i) + "\n"; break; }
    }
  }
  assert.ok(out, `@media ${query}`);
  return out;
}

/* ---------------------------------------------------------------- the top bar */

test("the top bar: paper with a 1 px edge, square, no blur and no shadow", () => {
  const bar = body(shell, ".topbar");
  assert.match(bar, /background:\s*var\(--color-bg\)/, "off-white paper");
  assert.match(bar, /border-bottom:\s*var\(--line\)/, "a 1 px edge in the line colour");
  assert.doesNotMatch(shell, /backdrop-filter/, "no glass");
  for (const m of shell.matchAll(/border-radius:\s*([^;}]+)/g)) assert.equal(m[1].trim(), "0", "square corners everywhere in the shell");
  for (const m of shell.matchAll(/box-shadow:\s*([^;}]+)/g)) assert.equal(m[1].trim(), "none", "no shadow in the shell");
  assert.match(read("src/shell/Rail.tsx"), /<RooksMark size=\{(2[0-9]|3[0-2])\}/, "a small mark");
});

test("the nav links are small uppercase mono in hairline cells; the current one is ink with a thin orange rule that slides", () => {
  const item = body(shell, ".rail-item");
  assert.match(item, /font-family:\s*var\(--font-mono\)/);
  assert.match(item, /text-transform:\s*uppercase/);
  assert.match(item, /letter-spacing:\s*var\(--tracking-button\)/);
  assert.match(item, /border-left:\s*var\(--line\)/, "cells split by hairlines");
  assert.match(body(shell, ".rail-label"), /font-size:\s*var\(--text-micro\)/);
  const ind = body(shell, ".rail-ind");
  assert.match(ind, /height:\s*2px/, "a thin rule, not a block");
  assert.match(ind, /background:\s*var\(--color-accent\)/, "in the orange");
  assert.match(ind, /transition:\s*transform var\(--dur-slide\)/, "it slides (and motion off stops it)");
  assert.match(body(shell, ".rail-item.is-active, .rail-item[aria-current=\"page\"]"), /color:\s*var\(--color-ink\)/, "the current tab is ink on paper (AA)");
});

test("one black rectangular call to action (search) that hovers to orange with ink words; the other buttons square with a 1 px line", () => {
  const rail = read("src/shell/Rail.tsx");
  assert.match(rail, /className="topbar-cta"/, "search is the call to action");
  assert.equal((rail.match(/topbar-cta"/g) || []).length, 1, "only one");
  const cta = body(shell, ".topbar-cta");
  assert.match(cta, /background:\s*var\(--color-primary\)/);
  assert.match(cta, /color:\s*var\(--color-on-primary\)/);
  assert.match(cta, /font-family:\s*var\(--font-mono\)/);
  const hover = body(shell, ".topbar-cta:hover");
  assert.match(hover, /background:\s*var\(--color-primary-hover\)/);
  assert.match(hover, /color:\s*var\(--color-on-primary-hover\)/, "ink on orange (white on orange fails AA)");
  const btn = body(shell, ".topbar-btn");
  assert.match(btn, /border:\s*var\(--line\)/);
  assert.match(btn, /width:\s*44px/);
  assert.doesNotMatch(rail, /glass-round/, "the round glass buttons are gone");
});

test("the group menus and More: square with an ink edge, micro-labels on top numbered like the pages, mono uppercase links", () => {
  const menu = body(shell, ".glass-menu");
  assert.match(menu, /border:\s*var\(--line-ink\)/);
  assert.match(menu, /background:\s*var\(--color-surface\)/);
  const rail = read("src/shell/Rail.tsx");
  assert.match(rail, /<MicroLabel n=\{placeOf\(/, "the menu's title is a micro-label with the place's number");
  const more = read("src/shell/MoreSheet.tsx");
  assert.match(more, /<MicroLabel n=\{placeOf\(/, "More's sections are micro-labels with the place's number");
  assert.match(more, /className="sr-only">\{g\.section\}/, "the section's name is still read once");
  for (const sel of [".rail-flyout-link", ".more-link"]) {
    const b = body(shell, sel);
    assert.match(b, /font-family:\s*var\(--font-mono\)/, sel);
    assert.match(b, /text-transform:\s*uppercase/, sel);
    assert.match(b, /border-top:\s*var\(--line\)/, `${sel}: hairline rows`);
  }
  assert.match(body(shell, ".more-pop-grid > .more-group + .more-group"), /border-left:\s*var\(--line\)/, "the sections split by hairlines");
  assert.match(media(shell, "(max-width: 900px)"), /\.more-link \{[^}]*height:\s*var\(--touch\)/, "44 px rows on phones");
});

test("the phone bar is docked flush with a 1 px top edge, square 44 px cells with mono labels", () => {
  const dock = body(shell, ".mobile-dock");
  assert.match(dock, /left:\s*0/);
  assert.match(dock, /right:\s*0/);
  assert.match(dock, /bottom:\s*0/);
  assert.match(dock, /border-top:\s*var\(--line\)/);
  assert.match(dock, /background:\s*var\(--color-bg\)/);
  const item = body(shell, ".mobile-item");
  assert.match(item, /min-height:\s*var\(--touch\)/);
  assert.match(item, /font-family:\s*var\(--font-mono\)/);
  assert.match(item, /text-transform:\s*uppercase/);
  assert.match(body(shell, ".mobile-count"), /background:\s*var\(--color-accent\)/);
  assert.match(body(shell, ".mobile-count"), /color:\s*var\(--color-on-accent\)/, "ink on orange");
});

test("the command menu: micro-label groups, mono hints, the picked row marked by a thin orange edge", () => {
  const group = body(styles, ".palette-group");
  assert.match(group, /font-family:\s*var\(--font-mono\)/);
  assert.match(group, /text-transform:\s*uppercase/);
  assert.match(group, /letter-spacing:\s*var\(--tracking-micro\)/);
  assert.match(styles, /\.palette-group::before \{[^}]*background:\s*var\(--color-accent\)/, "with the small orange square");
  assert.match(styles, /\.palette-item\[aria-selected="true"\]::before \{[^}]*width:\s*2px[^}]*background:\s*var\(--color-accent\)/);
  assert.match(body(styles, ".palette-item"), /border-top:\s*var\(--line\)/, "hairline rows");
  assert.match(body(styles, ".palette-foot"), /font-family:\s*var\(--font-mono\)/);
  assert.match(body(styles, ".palette-item .hint"), /text-transform:\s*uppercase/);
});

/* ---------------------------------------------------------------- the page frame */

test("each page knows its place in the navigation: [NN // PLACE], the same numbers as the menus", () => {
  assert.ok(places?.placeOf, "src/pages/places.ts exports placeOf");
  const p = places.placeOf;
  assert.deepEqual(p({ rail: "chat" }), { n: 1, name: "Chat" });
  assert.deepEqual(p({ rail: "jobs" }), { n: 3, name: "Jobs" });
  assert.deepEqual(p({ group: "day" }), { n: 4, name: "Day" });
  assert.deepEqual(p({ group: "library" }), { n: 6, name: "Library" });
  assert.deepEqual(p({ section: "Workspace" }), { n: 7, name: "Workspace" });
  assert.deepEqual(p({ rail: "settings" }), { n: 8, name: "Settings" }, "the Settings page and the Settings pages share a place");
  assert.deepEqual(p({ section: "Settings" }), { n: 8, name: "Settings" });
  assert.deepEqual(p({ section: "Advanced" }), { n: 9, name: "Advanced" });
  assert.equal(p({}), null, "a page with no place in the navigation has no label");
  // the names are the registry's own words
  const reg = read("src/pages/registry.ts");
  for (const w of ["Chat", "Room", "Jobs", "Settings"]) assert.match(reg, new RegExp(`label: "${w}", icon: \\w+, rail:`));
  for (const w of ["Day", "Memory", "Library"]) assert.match(reg, new RegExp(`label: "${w}", icon:`));
  const app = read("src/App.tsx");
  assert.match(app, /<PageMark\.Provider value=\{placeOf\(entry\)\}>/, "the route tells its page where it is");
});

test("the page header pattern: a left meta column (number and mono label) and the content on the right; stacked on phones", () => {
  const tsx = read("src/ui/index.tsx");
  assert.match(tsx, /export const PageMark = createContext/);
  assert.match(tsx, /<div className="ui-page-meta">/);
  assert.match(tsx, /<MicroLabel n=\{mark\.n\} name=\{mark\.name\} \/>/, "decoration: aria-hidden by default");
  assert.match(tsx, /<div className="ui-section-body">/, "a section's content sits in its own column");
  const wide = media(ui, "(min-width: 901px)");
  assert.match(wide, /\.ui-page-head \{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(var\(--grid-columns\), minmax\(0, 1fr\)\)/);
  assert.match(wide, /\.ui-page-meta \{[^}]*grid-column:\s*1 \/ span var\(--grid-meta-span\)/);
  assert.match(wide, /\.ui-page > \.ui-section:has\(> \.ui-section-head\) \{[^}]*display:\s*grid/, "top level sections with a title get the two columns");
  assert.match(wide, /\.ui-page > \.ui-section > \.ui-section-body \{[^}]*grid-column:\s*span calc\(var\(--grid-columns\) - var\(--grid-meta-span\)\)/);
  // phones: no grid, the meta on top (it comes first in the document)
  assert.doesNotMatch(body(ui, ".ui-page-head"), /display:\s*grid/, "stacked unless the window is wide");
});

test("headlines split in two lines, the second offset; the words are the same", () => {
  assert.ok(headline?.splitHeadline, "src/ui/headline.ts exports splitHeadline");
  const s = headline.splitHeadline;
  assert.deepEqual(s("What should Atlas do?"), ["What should", "Atlas do?"]);
  assert.deepEqual(s("Set a PIN or password"), ["Set a PIN", "or password"]);
  assert.deepEqual(s("Welcome back"), ["Welcome", "back"]);
  assert.deepEqual(s("Rooks"), ["Rooks", ""], "one word stays one line");
  for (const t of ["Sign in with the accounts you already use", "Choose how to think", "What do you do?"]) assert.equal(s(t).filter(Boolean).join(" "), t);
  const tsx = read("src/ui/index.tsx");
  assert.match(tsx, /export function Headline\(/);
  assert.match(tsx, /className="hl-line display-offset reveal"/);
  assert.match(styles, /\.display-offset \{[^}]*margin-left:/, "offset by a margin, so the orange wipe covers only the words");
});

test("the welcome and the sign-in are a hero: blueprint paper, the huge headline and a mono intro on the left, the card framed on the right", () => {
  const card = read("src/pages/settings/AuthCard.tsx");
  assert.match(card, /<Headline as="h1" className="st-auth-title"/);
  assert.match(card, /<MicroLabel name=\{step\} decorative=\{false\} \/>/, "the step is a micro-label, read aloud (the only place it is written)");
  assert.match(body(settings, ".auth.st-auth"), /background-image:\s*var\(--bg-grid\)/, "the blueprint grid");
  const title = body(settings, ".st-auth-title");
  assert.match(title, /font-family:\s*var\(--font-display\)/);
  assert.match(title, /font-size:\s*var\(--display-lg\)/);
  assert.match(body(settings, ".st-auth-line"), /font-family:\s*var\(--font-mono\)/, "a small mono intro");
  const frame = body(settings, ".auth-card.st-auth-card");
  assert.match(frame, /border:\s*var\(--line-ink\)/, "the card framed in 1 px");
  assert.match(settings, /\.auth-card\.st-auth-card::before \{[^}]*background:\s*var\(--color-accent\)/, "one orange accent on the frame");
  const wide = media(settings, "(min-width: 901px)");
  assert.match(wide, /\.st-auth-inner \{[^}]*grid-template-columns:\s*repeat\(var\(--grid-columns\), minmax\(0, 1fr\)\)/, "two columns on wide windows, stacked on phones");
  assert.match(settings, /\.st-step-n \{[^}]*border-radius:\s*0/, "the numbered steps are square");
});

test("Home is the second hero: the huge split headline on the blueprint, the rest in the right column", () => {
  const home = read("src/pages/Dashboard.tsx");
  assert.match(home, /<Page hero title=\{heading\}/);
  const tsx = read("src/ui/index.tsx");
  assert.match(tsx, /hero \? <Headline as="h1" className="ui-page-title ui-page-hero-title"/);
  assert.match(body(ui, ".ui-page-hero-title"), /font-size:\s*var\(--display-lg\)/);
  assert.match(body(ui, ".ui-page-head.is-hero"), /background-image:\s*var\(--bg-grid\)/);
  assert.doesNotMatch(body(day, ".day-home.ui-page"), /max-width:\s*720px/, "Home is as wide as a page, so the headline can be huge");
});
