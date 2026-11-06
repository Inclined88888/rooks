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
  // the Room shows only what the service reports, never a drawing of a desktop: its one <img> lives in RoomPicture,
  // mounted only while the Room says it is running with a real screen (roomScreenLive); otherwise the command view
  // says the honest line. The status comes from the Room's own route through one shared store.
  const room = read("../src/room/RoomView.tsx");
  const store = read("../src/room/status.ts");
  const words = read("../src/room/words.ts");
  assert.match(read("../src/pages/Room.tsx"), /room\/RoomPage/, "the /room route is the Room page");
  assert.match(store, /\/room\/status/);
  assert.match(store, /NOT_HERE_LINE/, "a service without the Room says so");
  assert.match(words, /NOT_HERE_LINE = "Not on this computer yet\."/);
  assert.equal((room.match(/<img/g) || []).length, 1, "one picture element");
  assert.ok(room.indexOf("<img") > room.indexOf("function RoomPicture"), "the picture element is inside RoomPicture");
  assert.match(room, /screenLive \? <RoomPicture/, "mounted only while the screen is really live");
  assert.match(room, /const screenLive = roomScreenLive\(/);
  assert.match(words, /Commands run as you, in a folder of its own\. It is not a locked off computer\./, "the honest command line");
  assert.match(room, /commandViewLine\(/, "the command view says it");
  assert.doesNotMatch(room, /A drawing of a terminal|fake|pretend/i);
});
