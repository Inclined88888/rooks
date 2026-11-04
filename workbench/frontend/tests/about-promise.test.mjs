// About says why this is one assistant, in plain words, with no rival names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const about = readFileSync(new URL("../src/pages/About.tsx", import.meta.url), "utf8");

test("About says it is yours, one memory, and it asks first", () => {
  assert.match(about, /runs on this computer/);
  assert.match(about, /share one memory/);
  assert.match(about, /asks before it sends a mail or clicks/);
  assert.match(about, /model is the one you choose/);
});

test("About does not name other assistants", () => {
  assert.doesNotMatch(about, /ChatGPT|Claude|Hermes|Codex|OpenClaw|Manus|Grok/);
});
