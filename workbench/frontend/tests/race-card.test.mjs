// The race card on the Jobs board (docs/design/0009-race.md, section 7): the scoreboard as a table, each row opening to
// its diff and test output, "Use this one" and "Use none", and the honest line once picked. Read from the source, as
// the other board guards are; the words must be the terminal's words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const jobs = read("../src/v02/Jobs.tsx");
const card = read("../src/v02/RaceCard.tsx");
const css = read("../src/v02/v02.css");

test("a job of kind race renders the race card, named Race", () => {
  assert.match(jobs, /kind === "race"/, "Jobs.tsx branches on the race kind");
  assert.match(jobs, /RaceCard/, "the card is its own component");
  assert.match(jobs, /race: "Race"/, "the kind is called Race on the card");
});

test("the card shows the scoreboard's measured columns, in the terminal's words", () => {
  for (const col of ["Proof", "Others' tests", "Project tests", "Diff", "Files", "Tokens", "Cost", "Time"]) {
    assert.ok(card.includes(col), `column ${col}`);
  }
  assert.match(card, /diff_text/, "a row opens to its diff");
  assert.match(card, /tests/, "a row opens to its test output");
});

test("the pick has two buttons and says what happens, and it goes through the pick route", () => {
  assert.ok(card.includes("Use this one"));
  assert.ok(card.includes("Use none"));
  assert.ok(card.includes("Picked here; the terminal applies it."));
  assert.match(card, /\/jobs\/\$\{[^}]+\}\/pick/, "the pick is posted to /jobs/{id}/pick");
  assert.match(card, /needs === "pick"/, "the buttons show only while the race waits for a pick");
});

test("the card speaks plainly: no addresses, ids or technical names", () => {
  const shown = card.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(shown, /https?:\/\//);
  assert.doesNotMatch(shown, />\s*(race_id|payload|json)\s*</i);
  assert.ok(css.includes(".race-board"), "the board has its own styles");
});
