// The assistant face is original, theme-coloured, and reacts when someone names it or says thanks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const face = read("../src/AssistantFace.tsx");
const css = read("../src/styles.css");

function noticedYou(text, name) {
  const said = text.trim().toLowerCase();
  if (!said) return false;
  if (/\b(thanks|thank you|cheers)\b/.test(said)) return true;
  const called = name.trim().toLowerCase();
  if (called.length < 2) return false;
  const safe = called.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${safe}\\b`).test(said);
}

test("naming or thanks is a small reaction, not every message", () => {
  assert.equal(noticedYou("thanks", "Riley"), true);
  assert.equal(noticedYou("Thank you for that", "Riley"), true);
  assert.equal(noticedYou("hey Riley, what's on today", "Riley"), true);
  assert.equal(noticedYou("plan my day", "Riley"), false);
  assert.equal(noticedYou("atlas mountains", "Atlas"), true);
  assert.equal(noticedYou("catalogue", "Atlas"), false);
  assert.match(face, /export function noticedYou/);
  assert.match(face, /pleasedAt/);
});

test("the face uses neutral theme colours and five still moods, and stays original", () => {
  for (const mood of ["idle", "thinking", "working", "done", "needs"]) {
    assert.match(css, new RegExp(`\\.mood-${mood}`));
  }
  // design system v3: the face is neutral (the accent is kept for live and needs you) and does not breathe or sway
  assert.match(css, /\.face-body \{ fill: var\(--panel-3\)/);
  assert.doesNotMatch(css, /@keyframes face-/);
  assert.doesNotMatch(css, /\.mood-[a-z]+ \{ animation/);
  assert.match(face, /eyes-happy/);
  assert.doesNotMatch(`${face}\n${css}`, /clippy|duo|grok|blob/i);
});
