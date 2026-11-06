// Guards for problems found by using the app: chats listed twice, and a dead terminal
// blamed on the shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const side = read("../src/chat/ChatList.tsx"); // the chats list lives in the Chat page's column now
const terminal = read("../src/pages/TerminalPage.tsx");
const app = read("../src/App.tsx");
const registry = read("../src/pages/registry.ts");
const vite = read("../vite.config.ts");
const tasks = read("../src/pages/Tasks.tsx");
const auto = read("../src/pages/Automations.tsx");

test("each chat is listed once, in plain words", () => {
  assert.match(side, /No chats yet/);
  assert.match(side, /Archive/);
  assert.match(side, /Delete/);
  assert.doesNotMatch(side, /No agents yet/);
  assert.match(side, /Search chats/);
  assert.doesNotMatch(side, /gi === 0/);
});

test("a dropped terminal connection is not called a shell exit", () => {
  assert.match(terminal, /The terminal could not connect/);
  assert.match(terminal, /if \(!alive\) return/);
  assert.match(vite, /ws:\s*true/);
});

test("the app has no virtual computer page; the Room never shows a fake screen", () => {
  assert.doesNotMatch(app, /\/try/);
  assert.doesNotMatch(registry, /\/try\b/);
  assert.doesNotMatch(`${app}\n${registry}`, /TryRoomPage/);
  assert.doesNotMatch(side, /Virtual computer/);
  // the Room page only shows what the service reports, never a drawing of a desktop
  const room = read("../src/pages/Room.tsx");
  assert.match(room, /\/room\/status/);
  assert.match(room, /Not on this computer yet\./);
  assert.doesNotMatch(room, /<img/);
});
