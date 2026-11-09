// The industrial redesign, step 5: the sweep (CHANGELOG "Unreleased · Industrial redesign"). Every route at 1440x900
// and 390x844 in light and dark showed these breaks; each test here failed on the tree before the sweep (scratchpad
// industrial/step5/fail-first.txt).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const css = (p) => strip(read(p));

/** The body of the first rule whose whole selector list is `sel`. */
function body(text, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`(?:^|[{}])\\s*${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `a rule for ${sel}`);
  return m[1];
}
/** Every `@media (pointer: coarse) { ... }` block in a stylesheet, joined. */
function coarse(text) {
  let out = "", at = text.indexOf("@media (pointer: coarse)");
  while (at >= 0) {
    let depth = 0;
    for (let i = text.indexOf("{", at); i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) { out += text.slice(text.indexOf("{", at) + 1, i) + "\n"; at = i; break; }
    }
    at = text.indexOf("@media (pointer: coarse)", at + 1);
  }
  return out;
}
const touch = (text, sel) => assert.match(coarse(text), new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{}]*\\{[^}]*var\\(--touch\\)`), `${sel} is a 44 px target on touch screens`);

test("a page title breaks between words, never inside one (AUTOMA / TIONS, COMPAN / Y on a phone)", () => {
  const ui = css("src/ui/ui.css");
  assert.doesNotMatch(body(ui, ".ui-page-title"), /overflow-wrap:\s*anywhere/);
  assert.match(body(ui, ".ui-page-title"), /overflow-wrap:\s*break-word/);
  assert.doesNotMatch(ui, /\.ui-section-title\s*\{[^}]*overflow-wrap:\s*anywhere/, "nor a section title in the left column");
});

test("the title takes its row before the page's buttons do: on a phone the buttons go under it", () => {
  assert.match(body(css("src/ui/ui.css"), ".ui-page-titles"), /flex:\s*1 1 \d+rem/);
});

test("an error in a narrow column puts Try again under its words instead of squeezing them to one word a line", () => {
  const ui = css("src/ui/ui.css");
  assert.match(body(ui, ".ui-error"), /flex-wrap:\s*wrap/);
  assert.match(body(ui, ".ui-error-text"), /flex:\s*1 1 \d+rem/);
});

test("the terminal window's bar has one orange square and grey ones, not red, yellow and green", () => {
  const styles = css("src/styles.css");
  assert.doesNotMatch(styles, /\.terminal-dots[^{]*\{[^}]*--screen-dot-(close|min|max)/);
  assert.match(styles, /\.terminal-dots i:first-child\s*\{[^}]*var\(--color-accent\)/);
  assert.match(body(styles, ".terminal-dots i"), /var\(--screen-mark\)/);
  assert.match(read("src/terminal/Shell.tsx"), /--screen-dot-close/, "program output keeps xterm's own red, yellow and green");
});

test("a new chat starts at its top, so the greeting's first line is not cut off on a phone", () => {
  const page = read("src/pages/Assistant.tsx");
  assert.match(page, /if \(messages\.length === 0\) return;\s*\n\s*endRef\.current\?\.scrollIntoView/);
});

test("a sentence beside a button in a bar (Skills) lets the button wrap under it on a phone", () => {
  assert.match(body(css("src/pages/agents/agents.css"), ".ag-bar > .ag-note.ag-grow"), /flex:\s*1 1 \d+rem/);
});

test("the team's three numbers stay one strip with 1 px dividers on a phone", () => {
  const team = css("src/team/team.css");
  assert.match(team, /\.team-stats\.st-stats\.is-three > :nth-child\(3\)\s*\{[^}]*grid-column:\s*auto[^}]*border-left:\s*var\(--line\)/);
});

test("Channels' setup steps: the number sits on the step's first line", () => {
  assert.match(body(css("src/teammates/teammates.css"), ".tm-wizard li button"), /display:\s*block/);
});

test("on touch screens every control the sweep found under 44 px is a 44 px target", () => {
  const ui = css("src/ui/ui.css");
  assert.match(coarse(ui), /\.ui-btn, \.ui-tab \{[^}]*min-width:\s*var\(--touch\);\s*flex-shrink:\s*0/, "buttons and tabs 44 px wide too, never squeezed under their words");
  assert.match(coarse(ui), /\.ui-chip-main\s*\{[^}]*margin-block/, "a chip's button covers its edge");
  touch(ui, "summary");
  touch(css("src/styles.css"), ".tab");
  touch(css("src/styles.css"), ".btn");
  touch(css("src/chat/chat.css"), ".chat-chip-select");
  touch(css("src/voice/voice.css"), ".dictate-mic");
  touch(css("src/appearance.css"), ".ap-seg button");
  touch(css("src/appearance.css"), ".ap-range");
  touch(css("src/pages/settings/settings.css"), ".st-choice-item");
  touch(css("src/pages/day/day.css"), ".day-home-field");
  touch(css("src/pages/day/day.css"), ".day-check");
  touch(css("src/pages/agents/agents.css"), ".ag-check");
  touch(css("src/teammates/teammates.css"), ".tm-wizard li button");
  touch(css("src/work.css"), ".terminal-tab");
  touch(css("src/work.css"), ".terminal-tab-x");
  assert.match(body(css("src/shell/shell.css"), ".skip-link"), /min-height:\s*var\(--touch\)/, "the skip link too");
});
