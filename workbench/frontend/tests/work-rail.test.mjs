// The side list is mail and tasks. Terminals stay mounted when you leave the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const context = read("../src/AgentsContext.tsx");
const side = read("../src/AgentsSidebar.tsx");
const app = read("../src/App.tsx");
const host = read("../src/terminalHost.tsx");
const code = read("../src/pages/Code.tsx");
const terminal = read("../src/pages/TerminalPage.tsx");

test("the right side is mail and tasks, and a job only while it is running", () => {
  assert.match(context, /Mail/);
  assert.match(context, /Tasks/);
  assert.match(context, /Working/);
  assert.doesNotMatch(context, /Open tabs/);
  assert.doesNotMatch(context, /On this computer/);
  assert.doesNotMatch(context, /Desktop/);
  assert.doesNotMatch(context, /agents-context-foot/);
});

test("recent sits above projects and is split into today and earlier", () => {
  const recent = side.indexOf(">Recent<");
  const projects = side.indexOf(">Projects<");
  assert.ok(recent > 0 && projects > recent);
  assert.match(side, /Today/);
  assert.match(side, /Earlier/);
  assert.match(side, /still open/);
  assert.doesNotMatch(side, /Virtual computer/);
});

test("terminal shells stay mounted away from the terminal page", () => {
  assert.match(app, /TerminalKeeper/);
  assert.match(app, /TerminalSlot/);
  assert.doesNotMatch(app, /<TerminalPage/);
  assert.match(host, /terminal-park/);
  assert.match(host, /requestAnimationFrame/);
  assert.match(terminal, /parked/);
  assert.match(terminal, /holdRef/);
  assert.match(terminal, /ws\.close\(\)/);
});

test("code keeps the real terminal, browser and computer", () => {
  assert.match(code, /TerminalSlot/);
  assert.match(code, />Browser</);
  assert.match(code, />Computer</);
  assert.doesNotMatch(code, /Virtual computer/);
  assert.doesNotMatch(code, /TryRoomPage/);
  assert.doesNotMatch(app, /path=\"\/try\"/);
});
