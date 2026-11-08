// The Rooks mark (docs/design/0007-room-browser-and-native-app.md, the mark): the chess rook as a plain tower, one
// rounded slab with three merlons and an arched doorway lit in gold, on an ink tile. The app draws it from one
// component (src/ui/RooksMark.tsx) in the top bar and on the welcome cards, the tab shows it as the favicon, and its
// colours are fixed tokens, the same in every mode, like the app icon on the computer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const maybe = (p) => (existsSync(new URL(p, import.meta.url)) ? read(p) : "");
const MERLONS = "H379V336H467V224H557V336H645V224";

test("one component draws the mark from fixed tokens", () => {
  const mark = maybe("../src/ui/RooksMark.tsx");
  assert.match(mark, /export function RooksMark\b/, "RooksMark exists");
  assert.ok(mark.replace(/\s/g, "").includes(MERLONS), "the tower with its three merlons");
  for (const t of ["--mark-ink", "--mark-paper", "--mark-gold"]) assert.ok(mark.includes(`var(${t}`), `the mark paints with ${t}`);
  assert.doesNotMatch(mark, /["'\s:(]#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/, "no hex in the component: the colours are tokens");
  assert.match(mark, /aria-hidden="true"/, "the mark is decoration: the button around it carries the words");
  const tokens = read("../src/tokens.css");
  const fixed = tokens.slice(tokens.indexOf("Fixed colours"));
  assert.match(fixed, /--mark-gold:\s*#E3A82B/i, "the gold door");
  assert.match(fixed, /--mark-paper:\s*#FAFAF9/i);
  assert.match(fixed, /--mark-ink:\s*#161615/i);
});

test("the top bar shows the tower, not a letter", () => {
  const rail = read("../src/shell/Rail.tsx");
  assert.match(rail, /<RooksMark\b/, "the rail mark is the tower");
  assert.doesNotMatch(rail, /charAt\(0\)/, "no first letter in its place");
  assert.match(rail, /aria-label=\{`\$\{name\}: search or jump to`\}/, "the button still says what it does");
});

test("the welcome cards and the loading screen carry the mark beside the name", () => {
  const card = read("../src/pages/settings/AuthCard.tsx");
  assert.match(card, /<RooksMark\b[^>]*\/>\s*\{PRODUCT\}|<RooksMark\b[\s\S]{0,120}\{PRODUCT\}/, "the mark sits beside Rooks");
  assert.match(read("../src/App.tsx"), /className="boot"[\s\S]{0,200}<RooksMark\b/, "the loading screen shows it too");
});

test("the browser tab shows the tower", () => {
  const fav = read("../public/favicon.svg");
  assert.ok(fav.replace(/\s/g, "").includes(MERLONS), "favicon: the tower");
  assert.match(fav, /#E3A82B/i, "favicon: the gold door");
  assert.doesNotMatch(fav, />R</, "favicon: no letter R");
  assert.match(read("../index.html"), /rel="icon" href="\/favicon\.svg"/);
});
