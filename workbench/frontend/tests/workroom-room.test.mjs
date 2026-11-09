// The Room stage, the watch surfaces, Needs you, Jobs and History (docs/design/0003-workroom.md, package F3).
// The honesty rules are the point: a picture of the Room is drawn only while the Room is running and says it has a
// real screen; input controls only when it has a pointer; otherwise a real command view with the honest line. The
// pure parts (words, the pointer mapping, the key mapping, the inbox words) are run; the rest is read from the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));
const maybe = (p) => (exists(p) ? read(p) : "");

/** Bundle one pure TypeScript module for node, or null when it does not exist yet. */
async function load(rel, name) {
  if (!exists(rel)) return null;
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false });
  const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}

const words = await load("../src/room/words.ts", "room-words.mjs");
const items = await load("../src/needs/items.ts", "needs-items.mjs");

// ---------------------------------------------------------------------------------------------- the Room, honestly
test("the Room says what it is in plain words: its isolation, its state, and the honest command line", () => {
  assert.ok(words, "src/room/words.ts exists");
  assert.equal(words.isolationWords("none"), "Not locked off");
  assert.equal(words.isolationWords("namespace"), "Your home folder kept apart");
  assert.equal(words.isolationWords("vm"), "A separate computer");
  assert.equal(words.isolationWords(undefined), "Not locked off", "an unknown isolation is never oversold");
  assert.equal(words.HONEST_LINE, "Commands run as you, in a folder of its own. It is not a locked off computer.");
  assert.equal(words.commandViewLine({ running: true, screen: false, isolation: "namespace", note: "" }), words.HONEST_LINE);
  assert.equal(words.commandViewLine({ running: true, screen: false, isolation: "none", note: "" }), words.HONEST_LINE);
  assert.match(words.commandViewLine({ running: true, screen: false, isolation: "vm", note: "" }), /separate computer/i);
  assert.equal(words.roomStateWords({ available: false }), "Not installed");
  assert.equal(words.roomStateWords({ available: true, running: false }), "Off");
  assert.equal(words.roomStateWords({ available: true, running: true }), "On");
  for (const w of [words.HONEST_LINE, words.isolationWords("none"), words.isolationWords("namespace"), words.isolationWords("vm")]) {
    assert.doesNotMatch(w, /driver|namespace|oauth|mcp|utc|workbench|https?:|cli:/i, w);
  }
});

test("a saved point is named by its label and when it was saved, never by its folder", () => {
  assert.ok(words, "src/room/words.ts exists");
  const p = words.describePoint("20261106T114501-before-upgrade-02");
  assert.equal(p.label, "before upgrade");
  assert.ok(p.date instanceof Date && !Number.isNaN(p.date.getTime()));
  assert.equal(p.date.getFullYear(), 2026);
  assert.equal(p.date.getMonth(), 10);
  assert.equal(p.date.getDate(), 6);
  assert.equal(p.date.getHours(), 11);
  assert.equal(p.date.getMinutes(), 45);
  assert.equal(words.describePoint("20261106T114501-save").label, "save");
  assert.equal(words.describePoint("odd").label, "odd");
  assert.equal(words.describePoint("odd").date, null);
  assert.doesNotMatch(words.pointLine("20261106T114501-before-upgrade"), /\//, "no folder path in the line");
  assert.match(words.pointLine("20261106T114501-before-upgrade"), /before upgrade/);
});

test("a click on the scaled picture lands on the Room's own pixels, and nothing outside the picture is sent", () => {
  assert.ok(words, "src/room/words.ts exists");
  const natural = { width: 1280, height: 720 };
  // the picture fills a 640 x 480 box: scaled to 640 x 360, letterboxed 60px top and bottom
  const box = { left: 100, top: 50, width: 640, height: 480 };
  assert.deepEqual(words.toScreenPoint({ x: 100, y: 110 }, box, natural), { x: 0, y: 0 });
  assert.deepEqual(words.toScreenPoint({ x: 420, y: 290 }, box, natural), { x: 640, y: 360 });
  assert.deepEqual(words.toScreenPoint({ x: 739, y: 469 }, box, natural), { x: 1278, y: 718 });
  assert.equal(words.toScreenPoint({ x: 400, y: 60 }, box, natural), null, "the letterbox is not the screen");
  assert.equal(words.toScreenPoint({ x: 400, y: 200 }, box, { width: 0, height: 0 }), null, "no picture, no point");
  assert.equal(words.toScreenPoint({ x: 10, y: 200 }, box, natural), null, "outside the box");
});

test("keys you press while stepped in become the Room's keys: text is typed, everything else is a named key", () => {
  assert.ok(words, "src/room/words.ts exists");
  assert.deepEqual(words.keyFor({ key: "a" }), { kind: "type", text: "a" });
  assert.deepEqual(words.keyFor({ key: "A", shiftKey: true }), { kind: "type", text: "A" });
  assert.deepEqual(words.keyFor({ key: " " }), { kind: "type", text: " " });
  assert.deepEqual(words.keyFor({ key: "é" }), { kind: "type", text: "é" });
  assert.deepEqual(words.keyFor({ key: "Enter" }), { kind: "key", keys: "Return" });
  assert.deepEqual(words.keyFor({ key: "Backspace" }), { kind: "key", keys: "BackSpace" });
  assert.deepEqual(words.keyFor({ key: "ArrowUp" }), { kind: "key", keys: "Up" });
  assert.deepEqual(words.keyFor({ key: "PageDown" }), { kind: "key", keys: "Page_Down" });
  assert.deepEqual(words.keyFor({ key: "c", ctrlKey: true }), { kind: "key", keys: "ctrl+c" });
  assert.deepEqual(words.keyFor({ key: "Tab", shiftKey: true }), { kind: "key", keys: "shift+Tab" });
  assert.deepEqual(words.keyFor({ key: "t", ctrlKey: true, altKey: true }), { kind: "key", keys: "ctrl+alt+t" });
  assert.deepEqual(words.keyFor({ key: "F5" }), { kind: "key", keys: "F5" });
  assert.deepEqual(words.keyFor({ key: "Escape" }), { kind: "key", keys: "Escape" });
  assert.equal(words.keyFor({ key: "Shift", shiftKey: true }), null, "a modifier on its own is nothing");
  assert.equal(words.keyFor({ key: "Control", ctrlKey: true }), null);
  // the wheel: the Room's scroll counts up as positive, so a wheel that moves the page down scrolls down
  assert.ok(words.wheelSteps(100) < 0);
  assert.ok(words.wheelSteps(-100) > 0);
  assert.equal(words.wheelSteps(0), 0);
});

test("the Room never draws a picture unless it is running with a real screen, and input only with a pointer", () => {
  const view = maybe("../src/room/RoomView.tsx");
  assert.ok(view, "src/room/RoomView.tsx exists");
  assert.match(view, /roomScreenLive\(/, "the one honesty check from chat/watch.ts decides");
  // the only <img> is inside the picture component, which is mounted only when the check passes
  const pictureAt = view.indexOf("function RoomPicture");
  assert.ok(pictureAt > -1, "RoomPicture is its own component");
  const firstImg = view.indexOf("<img");
  assert.ok(firstImg > pictureAt, "no <img> outside RoomPicture");
  assert.equal(view.indexOf("<img", firstImg + 1), -1, "one <img>, in RoomPicture");
  assert.match(view, /screenLive \? <RoomPicture/, "the picture is mounted only while the Room has a live screen");
  assert.match(view, /\/room\/screenshot\?k=/, "the picture comes from the Room's own screenshot route");
  // the command view is the other branch, with the honest line and the isolation in plain words
  assert.match(view, /function CommandView/);
  assert.match(view, /dockLine\(/); // the honest line's words, shown while terminals are on (room-pro.test.mjs)
  assert.match(view, /isolationWords\(/);
  assert.match(view, /\/room\/run/);
  // input controls only when the Room has a pointer; Esc or Hand back releases
  assert.match(view, /status\.pointer/);
  assert.match(view, /Step in/);
  assert.match(view, /Hand back/);
  assert.match(view, /"Escape"/);
  for (const route of ["/room/click", "/room/drag", "/room/scroll", "/room/type", "/room/key", "/room/checkpoint", "/room/reset", "/room/handoff", "/room/up", "/room/down"]) {
    assert.ok(view.includes(route), route);
  }
  assert.match(view, /Save a point/);
  assert.match(view, /Start over/);
  assert.match(view, /Hand off a file/);
  assert.match(view, /Needs you/, "a held hand-off points to Needs you");
  // the stage and the page share the view; the stage registers as the 'room' surface
  const stage = maybe("../src/room/RoomStage.tsx");
  assert.match(stage, /<StageFrame/);
  assert.match(stage, /title="The Room"/);
  const page = maybe("../src/room/RoomPage.tsx");
  assert.match(page, /RoomView/);
  assert.match(maybe("../src/pages/Room.tsx"), /room\/RoomPage/, "the /room route is the new page");
  // the status comes from one shared store on the shared poller: 5 s while a turn works there, 30 s while quiet, none
  // while the tab is hidden (the cadence itself is run in speed.test.mjs)
  const store = maybe("../src/room/status.ts");
  assert.match(store, /\/room\/status/);
  assert.match(store, /createPoller\(/);
  assert.match(store, /if \(hidden\) return null;/);
  // no technical words on the screen
  for (const src of [view, stage, page]) {
    assert.doesNotMatch(src, />[^<]*\b(driver|namespace|OAuth|MCP|UTC|Workbench)\b[^<]*</, "plain words only");
  }
});

// ---------------------------------------------------------------------------------------------- the Stage
test("every chat watch surface has a stage renderer, the thread card only opens the Stage, and the Stage opens itself once", () => {
  const surfaces = maybe("../src/stage/surfaces.tsx");
  assert.ok(surfaces, "src/stage/surfaces.tsx exists");
  for (const s of ['"room"', '"browser"', '"desktop"', '"terminal"']) assert.ok(surfaces.includes(`registerStageSurface(${s}`), `registers ${s}`);
  assert.match(surfaces, /watchSource\(/, "the one mapping says where each picture comes from");
  assert.match(surfaces, /roomScreenLive|RoomStage/, "the Room stage keeps the honesty check");
  assert.match(read("../src/App.tsx"), /registerStageSurfaces\(\)/, "the app registers the surfaces at start");
  const cards = read("../src/chat/ResultCards.tsx");
  assert.doesNotMatch(cards, /<img/, "the thread no longer polls a picture; the Stage shows it");
  assert.match(cards, /Open on the Stage/);
  assert.match(cards, /openStage\(/);
  assert.match(cards, /watchSource\(/, "the card still names the surface from the one mapping");
  const host = read("../src/shell/StageHost.tsx");
  assert.match(host, /same\(current, stage\)|sameStage\(/, "opening the surface that is already open keeps it as it is");
});

// ---------------------------------------------------------------------------------------------- Needs you
test("Needs you is one sheet: the pill, the bottom bar and the Jobs page open it, and every kind is answered in place", () => {
  assert.ok(items, "src/needs/items.ts exists");
  assert.equal(items.kindWord("approval"), "Chat");
  assert.equal(items.kindWord("room"), "Room");
  assert.equal(items.kindWord("job"), "Job");
  assert.equal(items.kindWord("desktop"), "Computer");
  assert.equal(items.kindWord("browser"), "Browser");
  assert.equal(items.effectFor({ kind: "room", tool: "use_room", effect: "external", args: JSON.stringify({ action: "handoff", src: "a.txt", dest: "/tmp/a.txt" }) }), "handoff");
  assert.equal(items.effectFor({ kind: "room", tool: "use_room", effect: "external", args: JSON.stringify({ action: "run", command: "ls" }) }), "external");
  assert.equal(items.effectFor({ kind: "approval", tool: "send_email", effect: "send", args: "{}" }), "send");
  assert.equal(items.effectFor({ kind: "desktop" }), "command");
  assert.equal(items.effectFor({ kind: "browser" }), "external");
  assert.equal(items.effectFor({ kind: "job" }), "external");
  assert.deepEqual(items.linkFor({ kind: "approval", conversation_id: 4, job_id: null }), { to: "/assistant/4", label: "Open chat" });
  assert.deepEqual(items.linkFor({ kind: "job", conversation_id: null, job_id: 9 }), { to: "/jobs", label: "Open jobs" });
  assert.deepEqual(items.linkFor({ kind: "desktop", conversation_id: null, job_id: "d1" }), { to: "/computer/d1", label: "Open computer" });
  assert.deepEqual(items.linkFor({ kind: "browser", conversation_id: null, job_id: "b1" }), { to: "/browser/b1", label: "Open browser" });
  assert.deepEqual(items.linkFor({ kind: "room", conversation_id: null, job_id: null }), { to: "/room", label: "Open the Room" });
  assert.equal(items.commandFor({ kind: "approval", args: JSON.stringify({ to: "dave@example.com", subject: "Hi" }) }).includes("dave@example.com"), true);
  assert.equal(items.commandFor({ kind: "job" }), "");
  // a Room item says what it is about, never its request id or the tool's action word
  const handoff = items.commandFor({ kind: "room", args: JSON.stringify({ action: "handoff", src: "report.txt", dest: "/tmp/out/report.txt", request_id: "room:3374a648d148" }) });
  assert.match(handoff, /report\.txt/);
  assert.match(handoff, /\/tmp\/out\/report\.txt/);
  assert.doesNotMatch(handoff, /request|room:3374|action|handoff/);
  assert.equal(items.commandFor({ kind: "room", args: JSON.stringify({ action: "run", command: "make test" }) }), "make test");
  assert.equal(items.commandFor({ kind: "room", args: JSON.stringify({ action: "up", goal: "Try the build" }) }), "Try the build");
  assert.equal(items.commandFor({ kind: "room", args: JSON.stringify({ action: "status" }) }), "");

  const sheet = maybe("../src/needs/NeedsYou.tsx");
  assert.ok(sheet, "src/needs/NeedsYou.tsx exists");
  assert.match(sheet, /import \{[^}]*Sheet[^}]*\} from "\.\.\/ui"/);
  assert.match(sheet, /<ApprovalCard/);
  assert.match(sheet, /\/needs-you/);
  assert.match(sheet, /\$\{[^}]+\}\/\$\{[^}]+\}|\/approve|\/deny/, "approve and deny go through the inbox route");
  assert.match(sheet, /refreshPresence\(\)/, "the pill count follows a decision at once");
  assert.match(sheet, /Nothing needs you/);
  assert.doesNotMatch(sheet, /role="alertdialog"/, "one approval card everywhere");
  assert.match(read("../src/shell/presence.ts"), /export function refreshPresence/);
  assert.match(read("../src/shell/PresenceStrip.tsx"), /openNeedsYou\(\)/);
  assert.match(read("../src/shell/MobileBar.tsx"), /openNeedsYou\(\)/);
  assert.match(read("../src/App.tsx"), /<NeedsYouSheet/, "mounted once, in the shell");
  const jobs = read("../src/v02/Jobs.tsx");
  assert.match(jobs, /id="needs-you"/);
  assert.match(jobs, /openNeedsYou\(\)/);
  assert.match(jobs, /#needs-you/, "the pill's link still lands on the inbox");
});

// ---------------------------------------------------------------------------------------------- Jobs and History
test("the Jobs page is built on the primitives and keeps every control and route", () => {
  const jobs = read("../src/v02/Jobs.tsx");
  assert.match(jobs, /import \{[^}]*\} from "\.\.\/ui"/);
  for (const c of ["Card", "Badge", "Button", "ApprovalCard", "EmptyState"]) assert.ok(new RegExp(`import \\{[^}]*\\b${c}\\b[^}]*\\} from "\\.\\./ui"`).test(jobs), `${c} from the primitives`);
  assert.doesNotMatch(jobs, /className="btn/, "no legacy buttons");
  assert.doesNotMatch(jobs, /\bEmpty\b.*from "\.\.\/util"/, "the legacy Empty is gone");
  for (const route of ['api<Board>("/jobs")', 'api("/jobs", { body: { kind, prompt } })', "/jobs/${j.id}/${verb}", "/approvals/${a.id}", '"/jobs/done"']) assert.ok(jobs.includes(route), route);
  for (const word of ["Pause", "Resume", "Stop", "Yes, run it", "Run again", "Start job", "Notify me", "Clear finished jobs", "Open chat", "What it was asked", "Result"]) assert.ok(jobs.includes(word), word);
  for (const col of ["Running", "Needs you", "Done"]) assert.ok(jobs.includes(`"${col}"`), col);
  assert.match(jobs, /<ApprovalCard/);
  assert.match(jobs, /Notification\.requestPermission/);
});

test("the History page is built on the primitives: Undo is a Button, Can't undo a Badge, chats open from each row", () => {
  const history = read("../src/pages/History.tsx");
  for (const c of ["Card", "Badge", "Button", "EmptyState", "Input", "Chip"]) assert.ok(new RegExp(`import \\{[^}]*\\b${c}\\b[^}]*\\} from "\\.\\./ui"`).test(history), `${c} from the primitives`);
  assert.doesNotMatch(history, /className="btn/, "no legacy buttons");
  assert.doesNotMatch(history, /\bEmpty\b[^\n]*from "\.\.\/util"/, "the legacy Empty is gone");
  assert.match(history, /<Badge[^>]*>\s*Can't undo/, "Can't undo is a badge");
  assert.match(history, /<Button[^>]*>[^<]*Undo</, "Undo is a button");
  assert.match(history, /Open chat/);
  assert.match(history, /<Link[^>]*to=\{`\/assistant\/\$\{/, "Open chat is a link to the chat");
  for (const route of ["/history/${e.id}/undo", "/history/export.", "status === 409"]) assert.ok(history.includes(route), route);
  for (const word of ["Yes, undo", "Keep it", "Help me fix it", "Show older", "Include look-ups", "Search your history", "Everything"]) assert.ok(history.includes(word), word);
});

// ---------------------------------------------------------------------------------------------- the rail
test("the Room item on the rail shows a live dot while the Room runs, from the one shared status store", () => {
  const rail = read("../src/shell/Rail.tsx");
  assert.match(rail, /roomOn\(usePresence\(\)\)/);
  assert.match(rail, /rail-live/);
  assert.match(read("../src/shell/MobileBar.tsx"), /roomOn\(p\)/);
  assert.match(read("../src/shell/shell.css"), /\.rail-live[^{]*\{[^}]*var\(--live\)|\.rail-live[^{]*\{[^}]*var\(--color-live\)/, "the dot is the live colour");
});
