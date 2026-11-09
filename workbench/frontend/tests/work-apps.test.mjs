// Design 0012: the work account (Microsoft 365) on its own Work apps page, the same switches and words as the terminal's
// /work (both read them from /api/work/status), files from work on the Files page, Planner and To Do on Tasks, Teams
// transcripts on Meetings, and what a Teams chat would need on Channels. Plain words; detail only under Advanced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));

test("Work apps is one page in Settings", () => {
  const registry = read("../src/pages/registry.ts");
  assert.match(registry, /path: "\/work", label: "Work apps"[^\n]*section: "Settings"[^\n]*import\("\.\/WorkApps"\)/);
  assert.ok(exists("../src/pages/WorkApps.tsx"));
});

test("the switches, their states and what they allow come from the app, as the terminal shows them", () => {
  const page = read("../src/pages/WorkApps.tsx");
  const term = read("../../../rooks-code/rooks_code/workroom.py");
  assert.match(page, /api<WorkStatus>\("\/work\/status"\)/);
  for (const field of ["label", "says", "state_words", "waiting_words", "asks_first"]) {
    assert.match(page, new RegExp(`\\.${field}\\b`), `the page shows ${field}`);
    assert.match(term, new RegExp(`["']${field}["']`), `the terminal shows ${field}`);
  }
  // the one fixed phrase both say the same way, from the app's words when it sends them
  assert.match(page, /words\?\.asks_first \?\? "Rooks always asks you first"/);
  assert.match(term, /or "Rooks always asks you first"/);
  // every switch the app has can be named in the terminal
  const ids = [...read("../../backend/app/work_scopes.py").matchAll(/\{"id": "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["mail", "calendar", "files_read", "files_change", "chats_read", "chats_post", "transcripts", "tasks"]);
  for (const id of ids) assert.match(term, new RegExp(`: "${id}"`), `the terminal can switch ${id}`);
});

test("a switch waiting for IT offers the note to copy; the technical detail is under Advanced only", () => {
  const page = read("../src/pages/WorkApps.tsx");
  assert.match(page, /Copy the request for IT/);
  assert.match(page, /\/work\/features\/\$\{f\.id\}\/it-note/);
  assert.match(page, /navigator\.clipboard\.writeText/);
  assert.match(page, /<Disclosure[^>]*summary="Advanced"/);
  const advanced = page.indexOf('summary="Advanced"');
  for (const tech of ["admin_consent", "tenant", "granted", "client_id_hint"]) {
    const at = page.indexOf(tech);
    assert.ok(at === -1 || at > advanced, `${tech} appears only under Advanced`);
  }
  const visible = page.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(visible, /OAuth|MCP|\bUTC\b|Workbench|cli:\/\/|AADSTS|Graph/);
});

test("signing in and switching use the app's own sign-in in the person's browser", () => {
  const page = read("../src/pages/WorkApps.tsx");
  assert.match(page, /api<Started>\(`\/work\/connect\/\$\{provider\}`/);
  assert.match(page, /connect\("microsoft"\)/);
  assert.match(page, /api<Switched>\(`\/work\/features\/\$\{f\.id\}`, \{ body: \{ on \} \}\)/);
  assert.match(page, /openExternal\(/);
  assert.match(page, /\/connect\/status\//);
  assert.match(page, /Google Workspace/);
});

test("Files has a From work tab: search, OneDrive, SharePoint sites and shared files, each with Save, Open and Ask", () => {
  const files = read("../src/pages/Files.tsx");
  const work = read("../src/pages/WorkFiles.tsx");
  assert.match(files, /From work/);
  assert.match(files, /<WorkFiles/);
  for (const call of ["/work/files", "/work/sites", "/work/files/save", "/work/status"]) assert.match(work, new RegExp(call.replace(/\//g, "\\/")));
  for (const words of ["Shared with me", "Save to Files", "Ask about it", "Open in the Room's browser", "Open in your browser"]) {
    assert.match(work, new RegExp(words.replace(/'/g, "'")), words);
  }
  assert.match(work, /\/room\/browser\/open/);
  assert.match(work, /can\?\.browser/);
});

test("Tasks says where a task lives; Meetings gets a Teams transcript; Channels says what a Teams chat needs", () => {
  const tasks = read("../src/pages/Tasks.tsx");
  assert.match(tasks, /planner: "Planner"/);
  assert.match(tasks, /todo: "To Do"/);
  assert.match(tasks, /\/work\/tasks\/sync/);
  const meetings = read("../src/pages/Meetings.tsx");
  assert.match(meetings, /Get the transcript from \$\{place\}/);
  assert.match(meetings, /useState\("Teams"\)/);
  assert.match(meetings, /\/work\/transcript/);
  assert.match(meetings, /\/work\/meetings/);
  const channels = read("../src/teammates/Channels.tsx");
  assert.match(channels, /Teams/);
  assert.match(channels, /to="\/work"/);
  assert.match(channels, /needs your company/i);
});

// Google Workspace (design 0012, section 2.3): the same page, tabs and cards, in the suite's own words from the app.
test("either suite signs in from Work apps, and the words come from the app's names for that suite", () => {
  const page = read("../src/pages/WorkApps.tsx");
  assert.match(page, /api<Started>\(`\/work\/connect\/\$\{provider\}`/);
  assert.match(page, /connect\("google"\)/);
  assert.match(page, /disabled=\{!st\.suites\.google\.ready/);
  assert.match(page, /names\??\.suite/);
  assert.doesNotMatch(page, /Google Workspace comes next/);
  const backend = read("../../backend/app/work_suite.py");
  assert.doesNotMatch(backend, /GOOGLE_LATER/);
  for (const n of ["My Drive", "Shared drives", "Google Chat", "Google Meet", "Google Tasks"]) assert.match(backend, new RegExp(n), n);
});

test("From work, Tasks, Meetings, Files and Channels name Google's apps when the work account is Google's", () => {
  const work = read("../src/pages/WorkFiles.tsx");
  assert.match(work, /names\.home/);
  assert.match(work, /names\.sites/);
  const files = read("../src/pages/Files.tsx");
  assert.match(files, /gdrive: "from Google Drive"/);
  const tasks = read("../src/pages/Tasks.tsx");
  assert.match(tasks, /gtasks: "Google Tasks"/);
  const meetings = read("../src/pages/Meetings.tsx");
  assert.match(meetings, /Get the transcript from \$\{/);
  assert.match(meetings, /\.online/);
  const channels = read("../src/teammates/Channels.tsx");
  assert.match(channels, /Google Chat/);
});

test("a held Docs or Sheets change shows what goes out and what comes in on the card", () => {
  const needs = read("../src/needs/NeedsYou.tsx");
  assert.match(needs, /item\.change/);
  assert.match(needs, /diff=\{/);
  const items = read("../src/needs/items.ts");
  assert.match(items, /change\?:/);
});
