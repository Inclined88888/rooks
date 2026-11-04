// Chat keeps modes, the approval strip, and the diff view. Show me how sits beside Chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const chat = read("../src/pages/Assistant.tsx");
const app = read("../src/App.tsx");
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
  assert.match(chat, /approvals-header/);
  assert.match(chat, /DiffView/);
});

test("Show me how sits in the top group beside Chat", () => {
  const top = app.slice(app.indexOf("const NAV"), app.indexOf("section: \"More\""));
  assert.match(top, /label: "Chat"/);
  assert.match(top, /label: "Show me how"/);
  assert.ok(top.indexOf('label: "Chat"') < top.indexOf('label: "Show me how"'));
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
