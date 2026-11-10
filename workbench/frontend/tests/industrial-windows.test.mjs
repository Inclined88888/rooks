// release/1.1: what feat/windows added (cut before the industrial redesign) restyled to the industrial design. Each test
// here failed on feat/windows's own stylesheets: the held work change drew rounded soft pills with a bold sans word, and
// the Room browser's start detail had a plain summary and a rounded well with no edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const css = (p) => readFileSync(root + p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function body(text, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`(?:^|[{}])\\s*${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `a rule for ${sel}`);
  return m[1];
}
const MICRO = (b, what) => {
  assert.match(b, /font-family:\s*var\(--font-mono\)/, `${what}: mono`);
  assert.match(b, /font-size:\s*var\(--text-micro\)/, `${what}: the micro size`);
  assert.match(b, /text-transform:\s*uppercase/, `${what}: caps`);
  assert.match(b, /letter-spacing:\s*var\(--tracking-micro\)/, `${what}: the micro tracking`);
};

test("a held work change in Needs you: square lines on hairlines, the word that says what changes a mono micro-label", () => {
  const needs = css("src/needs/needs.css");
  const li = body(needs, ".needs-change li");
  assert.doesNotMatch(li, /border-radius:\s*var\(--radius/, "no radius token on a change line: square");
  assert.match(li, /border-bottom:\s*var\(--line\)/, "each line on a hairline");
  assert.match(body(needs, ".needs-change"), /border-top:\s*var\(--line\)/);
  MICRO(body(needs, ".needs-change-word"), ".needs-change-word");
});

test("the Room browser's start detail under Advanced: a micro-label summary and a square well with a hairline edge", () => {
  const room = css("src/room/room.css");
  MICRO(body(room, ".room-browser-advanced summary"), ".room-browser-advanced summary");
  const pre = body(room, ".room-browser-advanced pre");
  assert.match(pre, /border:\s*var\(--line\)/);
  assert.match(pre, /border-radius:\s*0\b/);
});
