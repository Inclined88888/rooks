// Chat keeps modes, the approval strip, and the diff view. Show me how sits beside Chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const chat = ["../src/pages/Assistant.tsx", "../src/chat/Thread.tsx", "../src/chat/ThreadHeader.tsx", "../src/chat/Composer.tsx", "../src/chat/events.ts"].map(read).join("\n"); // the chat page is split (package F2)
const app = read("../src/pages/registry.ts"); // the one page registry App.tsx builds the nav from
const research = read("../src/pages/Research.tsx");
const skills = read("../src/pages/Skills.tsx");

test("Chat has modes, an approval strip, and a diff", () => {
  assert.match(chat, /aria-label="Mode"/);
  assert.match(chat, />Chat<\/button>/);
  assert.match(chat, />Code<\/button>/);
  assert.match(chat, /aria-label="Code"/);
  assert.match(chat, />Plan<\/button>/);
  assert.match(chat, />Build<\/button>/);
  assert.match(chat, /Chat is for the day/);
  assert.doesNotMatch(chat, /<option value="chat">/);
  assert.match(chat, /Something is waiting for your approval/);
  assert.doesNotMatch(chat, /approvals-header/);
  assert.match(chat, /DiffView/);
});

test("Chat is on the rail, Code is a page; old Customize links open Settings", () => {
  assert.match(app, /path: "\/assistant", label: "Chat", icon: \w+, rail: "chat"/);
  assert.match(app, /path: "\/code", label: "Code"/);
  assert.doesNotMatch(app, /path: "\/customize"/);
  assert.match(app, /\{ from: "\/customize", to: "\/settings" \}/);
  assert.match(app, /label: "Show me how"/);
  assert.ok(app.indexOf('label: "Chat"') < app.indexOf('label: "Show me how"'));
});

test("Research can look a report up in the browser and stay on the report", () => {
  assert.match(research, /Look this up/);
  assert.match(research, /\/browser\/jobs/);
  assert.doesNotMatch(research, /navigate\("\/browser/);
});

test("the Skills page keeps builder words under Advanced", () => {
  const main = skills.split("<details")[0];
  assert.doesNotMatch(main, /MCP/);
  assert.doesNotMatch(main, /SKILL\.md/);
  assert.match(skills, /<summary className="faint">Advanced<\/summary>/);
});
