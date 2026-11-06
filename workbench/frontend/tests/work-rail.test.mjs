// The chat is one column. Recent is chats. Mail failure is a sentence, not a second panel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const side = read("../src/chat/ChatList.tsx"); // the old sidebar's list, now the Chats column of the Chat page
const app = read("../src/App.tsx");
const registry = read("../src/pages/registry.ts");
const host = read("../src/terminalHost.tsx");
const code = read("../src/pages/Code.tsx");
const terminal = read("../src/pages/TerminalPage.tsx");
const chat = ["../src/pages/Assistant.tsx", "../src/chat/Thread.tsx", "../src/chat/ThreadHeader.tsx", "../src/chat/Composer.tsx", "../src/chat/events.ts"].map(read).join("\n"); // the chat page is split (package F2)
const beside = read("../src/Beside.tsx");
const shell = read("../src/shell/shell.css");

test("the chat has no default mail and tasks column: the shell is a 64px rail and the page", () => {
  assert.doesNotMatch(app, /AgentsContext/);
  assert.match(shell, /grid-template-columns: var\(--rail-w\) minmax\(0, 1fr\);/);
  assert.doesNotMatch(shell, /minmax\(0, 1fr\) 248px/);
});

test("recent is chats only, and an empty project list is not the product name", () => {
  assert.match(side, /"Recent"/);
  assert.match(side, /Today/);
  assert.match(side, /Earlier/);
  assert.doesNotMatch(side, /still open/);
  assert.doesNotMatch(side, /Customize/);
  assert.doesNotMatch(side, /label: "Terminal"/);
  assert.doesNotMatch(side, /aiw\.recent-places/);
  assert.match(side, /projectRows\.length > 0/);
  assert.doesNotMatch(side, /workspaceName \|\| "Home"/);
});

test("the composer names the model and has a send control, and a mail failure is one sentence", () => {
  assert.match(chat, /emptyLabel=/);
  assert.match(chat, />Send</);
  assert.match(chat, /Mail did not answer in time/);
  assert.match(chat, /Something is waiting for your approval/);
  assert.match(chat, /Open mail beside/);
  assert.doesNotMatch(chat, /approvals-header/);
  assert.doesNotMatch(chat, /Ask anything/);
});

test("a second screen stays closed until you ask, and it does not reopen a saved one", () => {
  assert.match(beside, /let current: BesideState \| null = null/);
  assert.doesNotMatch(beside, /readStoredBeside/);
  assert.doesNotMatch(beside, /Side by side/);
});

test("terminal shells stay mounted away from the terminal page", () => {
  assert.match(app, /TerminalKeeper/);
  assert.match(registry, /path: "\/terminal"[^\n]*TerminalSlot/);
  assert.doesNotMatch(`${app}\n${registry}`, /<TerminalPage/);
  assert.match(host, /terminal-park/);
  assert.match(host, /requestAnimationFrame/);
  assert.match(terminal, /parked/);
  assert.match(terminal, /holdRef/);
  assert.match(terminal, /ws\.close\(\)/);
});

test("the rail's Room item is live while the Room runs, and Needs you on the bottom bar opens the inbox sheet", () => {
  const rail = read("../src/shell/Rail.tsx");
  const bar = read("../src/shell/MobileBar.tsx");
  const store = read("../src/room/status.ts");
  assert.match(rail, /useRoomStatus\(\)/);
  assert.match(rail, /rail-live/);
  assert.match(store, /\/room\/status/);
  assert.match(store, /document\.hidden \? 15000 : 5000/, "one poller: 5 s, 15 s when hidden");
  assert.match(bar, /openNeedsYou\(\)/);
  assert.doesNotMatch(bar, /navigate\("\/jobs#needs-you"\)/, "the bar opens the sheet instead of leaving the page");
  assert.match(bar, /useRoomStatus\(\)/, "the bar's Room item carries the same live dot");
});

test("code keeps the real terminal, browser and computer", () => {
  assert.match(code, /TerminalSlot/);
  assert.match(code, />Browser</);
  assert.match(code, />Computer</);
  assert.doesNotMatch(code, /Virtual computer/);
  assert.doesNotMatch(code, /TryRoomPage/);
  assert.doesNotMatch(registry, /path: "\/try"/);
});
