// Side by side: a second screen stays up while the page you are on stays put.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BESIDE_SCREENS,
  clampRatio,
  readStoredBeside,
  safePath,
  screenPath,
  suggestBeside,
  writeStoredBeside,
} from "../src/besideLogic.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

test("chat opens the terminal beside it, and the terminal opens chat", () => {
  assert.equal(suggestBeside("/assistant"), "/terminal");
  assert.equal(suggestBeside("/assistant/4"), "/terminal");
  assert.equal(suggestBeside("/terminal"), "/assistant");
  assert.equal(suggestBeside("/code"), "/terminal");
  assert.equal(suggestBeside("/code/9"), "/terminal");
  assert.equal(suggestBeside("/files"), "/assistant");
});

test("the divider stays in a range a person can still use", () => {
  assert.equal(clampRatio(0.5), 0.5);
  assert.equal(clampRatio(0.05), 0.2);
  assert.equal(clampRatio(0.99), 0.8);
  assert.equal(clampRatio(Number.NaN), 0.5);
});

test("a saved side is a path in this app", () => {
  const bad = { getItem: () => JSON.stringify({ path: "javascript:alert(1)", ratio: 0.5 }) };
  assert.equal(readStoredBeside(bad), null);
  assert.equal(readStoredBeside({ getItem: () => "not json" }), null);
  assert.equal(safePath("//evil.example"), false);
  assert.equal(safePath("/notes/3"), true);
  const mem = new Map();
  const storage = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => mem.set(k, v),
    removeItem: (k) => mem.delete(k),
  };
  writeStoredBeside(storage, { path: "/notes/3", ratio: 0.1 });
  assert.deepEqual(readStoredBeside(storage), { path: "/notes/3", ratio: 0.2 });
  writeStoredBeside(storage, null);
  assert.equal(readStoredBeside(storage), null);
});

test("screen names stay the words people already see", () => {
  assert.equal(screenPath("/assistant/2"), "/assistant");
  const labels = BESIDE_SCREENS.map((s) => s.label);
  for (const word of ["Chat", "Terminal", "Files", "Notes", "Tasks", "Mail"]) {
    assert.ok(labels.includes(word), word);
  }
  assert.equal(labels.includes("Virtual computer"), false);
  assert.equal(safePath("/try"), false);
  for (const label of labels) {
    assert.equal(/oauth|mcp|workbench|cli:|https?:/i.test(label), false, label);
  }
});

test("the shell keeps the second screen on its own route", () => {
  const beside = read("../src/Beside.tsx");
  const app = read("../src/App.tsx");
  const side = read("../src/AgentsSidebar.tsx");
  const context = read("../src/AgentsContext.tsx");
  const assistant = read("../src/pages/Assistant.tsx");
  assert.match(beside, /Side by side/);
  assert.match(beside, /One screen/);
  assert.match(beside, /Swap sides/);
  assert.match(beside, /Drag the bar to resize/);
  assert.match(beside, /MemoryRouter/);
  // React Router 6 forbids nesting MemoryRouter under BrowserRouter; a separate root is required.
  assert.match(beside, /createRoot/);
  assert.match(beside, /BesideExtraHost/);
  assert.match(beside, /safePath/);
  assert.match(beside, /Open \$\{label\} beside this/);
  assert.match(app, /BesideStage/);
  assert.match(side, /Archive/);
  assert.match(side, /Delete/);
  assert.doesNotMatch(side, /BesideButton/);
  assert.doesNotMatch(context, /BesideButton/);
  // A chat on the side must follow its own screen, and leaving the main chat must not pull you back.
  assert.match(assistant, /mounted\.current/);
  assert.doesNotMatch(assistant, /window\.location\.pathname\.startsWith\("\/assistant"\)/);
  assert.doesNotMatch(assistant, /window\.location\.pathname === "\/assistant"/);
});
