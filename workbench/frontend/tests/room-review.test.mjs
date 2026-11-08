// The Room desk review (docs/design/0006-room-desktop.md): each finding on the frontend has a test here that failed on
// the code before its fix. The pure modules (desk, words, the status store with the terminals store, plainStep) are run
// through esbuild; the components are read from the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const cacheDir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));

async function bundle(opts, name) {
  const out = await build({ bundle: true, format: "esm", platform: "node", write: false, ...opts });
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheDir + name, out.outputFiles[0].text);
  return import(pathToFileURL(cacheDir + name).href);
}
const load = (rel, name) => (exists(rel) ? bundle({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))] }, name) : null);

const desk = await load("../src/room/desk.ts", "review-desk.mjs");
const words = await load("../src/room/words.ts", "review-words.mjs");
const { plainStep } = await load("../src/plainStep.ts", "review-plainStep.mjs");
// the status store and the terminals store together, one copy of each, as the app has them
const stores = await bundle({
  stdin: { contents: 'export * from "./src/room/status.ts"; export * as terms from "./src/room/terms.ts";', resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
}, "review-stores.mjs");

const ON = { checked: true, reachable: true, available: true, running: true, screen: false, pointer: false, terminals: [], terminal_max: 4 };

/** The source of a component, or "" (the guard then fails on the assert, not on a missing file). */
const src = (p) => (exists(p) ? read(p) : "");

// ---------------------------------------------------------------------------------------------- switched off (9, 10, 31)
test("terminals switched off in Settings come from status: the Terminal window stays, with its Settings line", () => {
  const s = stores.roomFromWire({ available: true, running: true, can: { terminal: false, files: true, terminal_off_reason: "switched_off" } });
  assert.equal(s.can.terminal_off_reason, "switched_off", "the status store keeps why there is no terminal");
  assert.equal(stores.roomFromWire({ available: true, can: { terminal: false, terminal_off_reason: "sideways" } }).can.terminal_off_reason, null, "an unknown reason is no reason");
  assert.equal(stores.roomFromWire({ available: true }).can.terminal_off_reason, null, "an older service says nothing");
  // the Terminal window shows the switched-off state; Commands is only for helper mode and Windows (design 3.5)
  assert.deepEqual(desk.windowsFor({ ...ON, can: { terminal: false, files: true, terminal_off_reason: "switched_off" } }), ["terminal", "files", "points"]);
  assert.deepEqual(desk.windowsFor({ ...ON, can: { terminal: false, files: false, terminal_off_reason: "helper" } }), ["commands", "points"]);
  assert.deepEqual(desk.windowsFor({ ...ON, can: { terminal: false, files: true, terminal_off_reason: "windows" } }), ["commands", "files", "points"]);
  assert.equal(desk.terminalsSwitchedOff({ can: { terminal: false, terminal_off_reason: "switched_off" } }, false), true, "status says so before any socket");
  assert.equal(desk.terminalsSwitchedOff({ can: { terminal: true, terminal_off_reason: null } }, true), false, "status says they are on: the old refusal no longer counts");
  assert.equal(desk.terminalsSwitchedOff({ can: { terminal: false } }, true), true, "an older service: the socket's refusal stands");
  assert.equal(desk.terminalsSwitchedOff({ can: { terminal: false } }, false), false);
  // the Commands label says why only from the reason (helper mode), with the old guess when the service says nothing
  assert.match(words.commandsLabelFor({ available: true, isolation: "none", can: { terminal: false, files: false, terminal_off_reason: "helper" } }), /A terminal needs the Room on this computer\./);
  assert.equal(words.commandsLabelFor({ available: true, isolation: "none", can: { terminal: false, files: true, terminal_off_reason: "windows" } }), "One command at a time, up to two minutes each.");
  assert.match(words.commandsLabelFor({ available: true, isolation: "none", can: { terminal: false, files: false } }), /A terminal needs the Room on this computer\./);

  const win = src("../src/room/TerminalWindow.tsx");
  assert.match(win, /terminalsSwitchedOff\(status, ui\.switchedOff\)/, "the window and the panes read the switched-off state from status");
  assert.doesNotMatch(win, /if \(ui\.remote \|\| ui\.switchedOff/, "the panes do not stay hidden on the old refusal alone");
  assert.match(win, /to="\/settings">Open Settings</, "the switched-off state links to Settings");
});

test("the switched-off refusal is forgotten as soon as status says terminals are on", () => {
  const { terms } = stores;
  terms.setPaneWords("t1", { line: "Terminals are switched off in Settings.", blocked: "settings" });
  assert.equal(terms.getTerms().switchedOff, true);
  stores.receiveRoomStatus({ available: true, running: true, can: { terminal: false, files: true } });
  assert.equal(terms.getTerms().switchedOff, true, "an answer that does not say they are on keeps it");
  stores.receiveRoomStatus({ available: true, running: true, can: { terminal: true, files: true } });
  assert.equal(terms.getTerms().switchedOff, false, "status says terminals are on: the latch is cleared");
  assert.equal(terms.getTerms().words.t1?.blocked ?? "", "", "and the pane's refusal goes with it, so its socket is asked again");
});

// ---------------------------------------------------------------------------------------------- Start over on the Stage (11, 19)
test("the Stage's Start over names how many terminals close, and the Stage has one Save a point and one Start over", () => {
  assert.equal(words.resetLine(0), "This puts the Room's files back as they were at that point. Anything done since is lost. The Room restarts if it is on.");
  assert.equal(words.resetLine(2), "This puts the Room's files back as they were at that point. Anything done since is lost. The Room restarts if it is on. 2 terminals will close.");
  assert.match(words.resetLine(1), /1 terminal will close\.$/);
  const view = src("../src/room/RoomView.tsx");
  const panel = view.slice(view.indexOf("export function ResetPanel"), view.indexOf("export function HandoffPanel"));
  assert.match(panel, /resetLine\(closing\)/, "ResetPanel says the count");
  assert.match(view, /<ResetPanel [^>]*closing=\{status\.terminals\.filter\(\(t\) => t\.alive\)\.length\}/, "the frame passes the open terminals");
  // with the Saved points window showing, the frame's own Save a point and Start over step aside
  assert.match(view, /pointsShown/, "useRoomFrame knows when the Points window shows");
  assert.match(view, /!pointsShown && \(/, "the frame's point verbs hide while it shows");
  const stage = src("../src/room/RoomStage.tsx");
  assert.match(stage, /pointsShown: shown === "points"/);
});

// ---------------------------------------------------------------------------------------------- touch (12)
test("on touch screens every Room verb is a 44 px target", () => {
  const css = strip(read("../src/room/room.css"));
  const coarse = [...css.matchAll(/@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  assert.ok(coarse, "room.css has a pointer: coarse block");
  const rules = [...coarse.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].split(",").map((s) => s.trim()), body: m[2] }));
  const big = (sel) => rules.some((r) => r.sel.includes(sel) && /min-height:\s*44px/.test(r.body) && /min-width:\s*44px/.test(r.body));
  // the page (bar, window title bars, rows, confirms, the ended row, the phone menu), the Stage (frame and dock), the forms
  for (const sel of [".room-page .ui-btn", ".room-page .ui-iconbtn", ".room-frame .ui-btn", ".room-frame .ui-iconbtn", ".room-panel .ui-btn", ".room-held .ui-btn", ".room-held .ui-iconbtn"]) {
    assert.ok(big(sel), `${sel} is 44 px on touch`);
  }
});

// ---------------------------------------------------------------------------------------------- the skip link (13)
test("Skip the terminal lands somewhere on the Stage too", () => {
  const found = new Map([["room-stage-dock", { id: "room-stage-dock" }]]);
  assert.equal(desk.skipTarget((id) => found.get(id) ?? null)?.id, "room-stage-dock", "beside the chat the Stage's dock takes focus");
  const page = new Map([["room-files-title", { id: "room-files-title" }], ["room-dock", { id: "room-dock" }]]);
  assert.equal(desk.skipTarget((id) => page.get(id) ?? null)?.id, "room-files-title", "on the page the Files title first");
  assert.equal(desk.skipTarget(() => null), null);
  const stage = src("../src/room/RoomStage.tsx");
  assert.match(stage, /className="room-stage-dock" id="room-stage-dock" tabIndex=\{-1\}/, "the Stage's dock can take focus");
  assert.match(src("../src/room/TerminalWindow.tsx"), /skipTarget\(/, "the skip link uses the same list");
});

// ---------------------------------------------------------------------------------------------- Show in terminal (14, 35)
test("Show in terminal says what it did, names only the last folder, and waits while the terminal is busy", () => {
  assert.equal(words.typedCdWords("projects/site/src", "Terminal 1"), "Typed a cd to src into Terminal 1.");
  assert.equal(words.typedCdWords("", "Terminal 2"), "Typed a cd to Home into Terminal 2.");
  assert.equal(words.showInTerminalBlock(null), "Open a terminal first");
  assert.equal(words.showInTerminalBlock({ id: "a", name: "Terminal 1", owner: "person", alive: true, busy: true }), "Terminal 1 is running something. Wait until it finishes.");
  assert.equal(words.showInTerminalBlock({ id: "a", name: "Terminal 1", owner: "person", alive: true, busy: false }), "");
  const files = src("../src/room/FilesWindow.tsx");
  assert.doesNotMatch(files, /The terminal is in/, "no claim the cd ran");
  assert.match(files, /typedCdWords\(/);
  assert.match(files, /showInTerminalBlock\(terminal\)/);
});

// ---------------------------------------------------------------------------------------------- the bar's word (15)
test("before the Room has ever answered, the bar claims no state", () => {
  assert.equal(words.roomBarWord({ checked: false, reachable: true, answered: false, available: false, running: false }), "");
  assert.equal(words.roomBarWord({ checked: true, reachable: false, answered: false, available: false, running: false }), "", "never answered: not \"Not installed\"");
  assert.equal(words.roomBarWord({ checked: true, reachable: false, answered: true, available: true, running: true }), "On", "away: the last known word stays");
  assert.equal(words.roomBarWord({ checked: true, reachable: true, answered: true, available: false, running: false }), "Not installed");
  const away = stores.unreachable({ checked: false, reachable: true, answered: false, available: false });
  assert.equal(away.answered, false);
  assert.equal(away.reachable, false);
  assert.equal(stores.roomFromWire({ available: true }).answered, true);
  assert.match(src("../src/room/RoomPage.tsx"), /const word = roomBarWord\(status\)/);
});

// ---------------------------------------------------------------------------------------------- one count (16)
test("one terminal count everywhere: what the cap counts, ended ones included", () => {
  const two = { terminals: [{ id: "a", alive: true }, { id: "b", alive: false }], terminal_max: 4 };
  assert.equal(desk.terminalsCounted(two), 2, "without the field, every record the service lists");
  assert.equal(desk.terminalsCounted({ ...two, terminal_count: 3 }), 3, "the service's count when it says");
  assert.equal(desk.terminalsFull({ ...two, terminal_count: 4 }), true);
  assert.equal(desk.terminalsFull(two), false);
  assert.equal(stores.roomFromWire({ available: true, terminal_count: 3 }).terminal_count, 3);
  assert.equal(words.fullLine(4), "Four terminals are in the Room, ended ones included. Close one to open another.");
  assert.equal(words.terminalCountLine({ counted: 2, open: 1, max: 4 }), "2 of 4, ended ones included (1 open)");
  assert.equal(words.terminalCountLine({ counted: 2, open: 2, max: 4 }), "2 of 4");
  assert.match(src("../src/room/TerminalWindow.tsx"), /const full = terminalsFull\(status\)/);
  assert.match(src("../src/room/RoomPage.tsx"), /terminalCountLine\(/);
});

// ---------------------------------------------------------------------------------------------- links (17)
test("a link says where it leads, the same words as the terminal's /room files", () => {
  assert.equal(desk.entryMeta({ kind: "link", why: "outside", size: null }), "link, leads outside the Room");
  assert.equal(desk.entryMeta({ kind: "link", why: "broken", size: null }), "link, leads nowhere");
  assert.equal(desk.entryMeta({ kind: "link", size: null }), "link", "an older service: just link");
  assert.doesNotMatch(src("../src/room/FilesWindow.tsx"), /points outside the Room/, "no hard-coded claim");
});

// ---------------------------------------------------------------------------------------------- the socket's ends (18, 30)
test("a terminal opened in another window can be used here again, and a lost connection offers Reconnect", () => {
  assert.deepEqual(desk.afterClose(1000, "This terminal was opened in another window.", 0), { retry: false, action: "here" });
  assert.deepEqual(desk.afterClose(1006, "", 0), { retry: true, action: "" });
  assert.deepEqual(desk.afterClose(1006, "", 2), { retry: true, action: "" });
  assert.deepEqual(desk.afterClose(1006, "", 3), { retry: false, action: "reconnect" }, "after the last retry: a button");
  assert.deepEqual(desk.afterClose(4404, "", 0), { retry: false, action: "" });
  assert.equal(words.closeWords(1006, "", true), "The terminal lost its connection. Trying again…");
  assert.equal(words.closeWords(1006, "", false), "The terminal lost its connection.", "no Trying again once it stopped trying");
  assert.equal(words.closeWords(1000, "This terminal was opened in another window.", false), "This terminal was opened in another window.");
  assert.equal(words.closeWords(4403, "Wrong origin", false), "The terminal only opens on the computer running Rooks.", "no technical reason on screen");
  const win = src("../src/room/TerminalWindow.tsx");
  assert.match(win, />Use it here</);
  assert.match(win, />Reconnect</);
  assert.match(win, /reattachTerminal\(/);
});

// ---------------------------------------------------------------------------------------------- ended once (20)
test("an ended terminal says so once in the window: no copy of the line under the box", () => {
  const win = src("../src/room/TerminalWindow.tsx");
  const at = win.indexOf('className="room-term-ended"');
  assert.ok(at > -1);
  const row = win.slice(at, win.indexOf("</div>", at));
  assert.doesNotMatch(row, /endedLine\(/, "the line is printed in the terminal already");
  assert.match(row, /Open a new terminal/);
});

// ---------------------------------------------------------------------------------------------- not only phones (21)
test("the tail view's words fit any device that is not the computer running Rooks", () => {
  assert.doesNotMatch(words.tailLine(), /phone/i);
  assert.equal(words.tailLine(), "This page shows the terminal's last lines and sends what you type. Open the Room on the computer running Rooks for the full terminal.");
});

// ---------------------------------------------------------------------------------------------- rename by keyboard (22)
test("a terminal tab can be renamed from the keyboard, and it does not look draggable", () => {
  assert.equal(desk.tabKey("F2"), "rename");
  assert.equal(desk.tabKey("Enter"), "rename");
  assert.equal(desk.tabKey("ArrowRight"), 1);
  assert.equal(desk.tabKey("ArrowLeft"), -1);
  assert.equal(desk.tabKey("a"), null);
  const win = src("../src/room/TerminalWindow.tsx");
  assert.match(win, /tabKey\(e\.key\)/);
  assert.match(win, /press F2 to rename/);
  const css = strip(read("../src/room/room.css"));
  assert.match(css, /\.room-tab\s*\{[^}]*cursor:\s*pointer/);
});

// ---------------------------------------------------------------------------------------------- the step words (23)
test("a command Rooks starts in a Room terminal is said as running it, with what it is", () => {
  assert.equal(plainStep("use_room", JSON.stringify({ action: "start", command: "npm run build" })), "Running in the Room's terminal: npm run build");
  assert.equal(plainStep("use_room", JSON.stringify({ action: "start" })), "Running in the Room's terminal");
});

// ---------------------------------------------------------------------------------------------- stale points (24)
test("while Rooks does not answer, the Points window's verbs are disabled like the bar's", () => {
  const points = src("../src/room/PointsWindow.tsx");
  assert.match(points, /disabled=\{naming \|\| !status\.available \|\| stale\}/, "Save a point");
  assert.match(points, /disabled=\{stale\}[^>]*onClick=\{\(\) => setConfirm\(p\.name\)\}/, "Start over from here");
});

// ---------------------------------------------------------------------------------------------- Advanced (b)
test("Advanced says what is kept: each terminal's text in a private log until it closes, and lines from another device", () => {
  assert.equal(words.RECORDED_LINE,
    "Each terminal's text is kept in a private log on this computer until the terminal is closed. Opening and closing a terminal, every command Rooks starts, and lines sent from another device are in the run log; hidden input, such as a password, is not.");
  assert.match(src("../src/room/RoomPage.tsx"), /<dt>What is recorded<\/dt><dd>\{RECORDED_LINE\}<\/dd>/);
});
