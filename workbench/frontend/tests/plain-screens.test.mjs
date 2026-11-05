// Guards for problems found by using the app: chats listed twice, a dead terminal
// blamed on the shell, and the practice computer pretending to be a desktop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const side = read("../src/AgentsSidebar.tsx");
const terminal = read("../src/pages/TerminalPage.tsx");
const practice = read("../src/pages/TryRoomPage.tsx");
const vite = read("../vite.config.ts");
const tasks = read("../src/pages/Tasks.tsx");
const auto = read("../src/pages/Automations.tsx");

test("each chat is listed once, in plain words", () => {
  assert.match(side, /No chats yet/);
  assert.doesNotMatch(side, /No agents yet/);
  assert.match(side, /Search chats/);
  assert.doesNotMatch(side, /gi === 0/);
});

test("a dropped terminal connection is not called a shell exit", () => {
  assert.match(terminal, /The terminal could not connect/);
  assert.match(terminal, /if \(!alive\) return/);
  assert.match(vite, /ws:\s*true/);
});

test("a folder practice computer offers a command instead of a fake screen", () => {
  assert.match(practice, /Try a command/);
  assert.match(practice, /Commands run as you/);
  assert.match(practice, /screen === false/);
  assert.doesNotMatch(practice, /st\.running && shotOk \?/);
});
