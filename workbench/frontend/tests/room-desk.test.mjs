// The Room as a small computer (docs/design/0006-room-desktop.md, sections 2 to 5 and 9.5): a desk of plain windows
// built from the Room's status, a dock that opens and closes them, and a terminal that stays. The pure modules (the
// desk, the words, the status store) are run through esbuild; the components are read from the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));
const maybe = (p) => (exists(p) ? read(p) : "");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Bundle one pure TypeScript module for node, or null when it does not exist yet. */
async function load(rel, name) {
  if (!exists(rel)) return null;
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false });
  const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}

const desk = await load("../src/room/desk.ts", "room-desk.mjs");
const words = await load("../src/room/words.ts", "room-desk-words.mjs");
const store = await load("../src/room/status.ts", "room-desk-status.mjs");

const SHELL_ON = { checked: true, reachable: true, available: true, running: true, screen: false, pointer: false, can: { terminal: true, files: true }, terminals: [], terminal_max: 4 };
const NESTED_ON = { ...SHELL_ON, screen: true, pointer: true };
const fakeStorage = (raw) => {
  const m = new Map(raw === undefined ? [] : [["rooks.room.desk", raw]]);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
};

// ---------------------------------------------------------------------------------------------- 24: the windows
test("the windows come from status: a window status does not offer does not exist", () => {
  assert.ok(desk, "src/room/desk.ts exists");
  assert.deepEqual(desk.windowsFor(SHELL_ON), ["terminal", "files", "points"]);
  assert.deepEqual(desk.windowsFor(NESTED_ON), ["screen", "terminal", "files", "points"]);
  assert.deepEqual(desk.windowsFor({ ...SHELL_ON, can: { terminal: false, files: true } }), ["commands", "files", "points"]);
  assert.deepEqual(desk.windowsFor({ ...SHELL_ON, can: { terminal: true, files: false } }), ["terminal", "points"]);
  assert.deepEqual(desk.windowsFor({ ...SHELL_ON, can: undefined }), ["commands", "points"], "an older service without terminals keeps Commands");
  assert.deepEqual(desk.windowsFor({ ...SHELL_ON, available: false }), []);
  assert.deepEqual(desk.windowsFor({ ...SHELL_ON, checked: false }), []);
  assert.deepEqual(desk.windowsFor({ ...SHELL_ON, running: false }), ["terminal", "files", "points"], "Files and Saved points work while the Room is off");
  // the browser remembers only which windows are open; a remembered Screen on a Room without one is dropped
  const remembered = fakeStorage(JSON.stringify({ open: ["screen", "terminal"] }));
  assert.deepEqual(desk.readDesk(SHELL_ON, remembered), ["terminal"]);
  assert.ok(!desk.readDesk(SHELL_ON, fakeStorage(JSON.stringify({ open: ["screen"] }))).includes("screen"));
  assert.deepEqual(desk.readDesk(SHELL_ON, fakeStorage("not json")), ["terminal", "files", "points"], "a broken memory falls back to the default");
  assert.deepEqual(desk.readDesk(SHELL_ON, fakeStorage()), desk.defaultOpen(SHELL_ON));
  assert.deepEqual(desk.defaultOpen(SHELL_ON), ["terminal", "files", "points"], "primary window, Files and Points");
  assert.deepEqual(desk.defaultOpen(NESTED_ON), ["screen", "files", "points"]);
  const s = fakeStorage();
  desk.writeDesk(["terminal", "files"], s);
  assert.deepEqual(JSON.parse(s.map.get("rooks.room.desk")), { open: ["terminal", "files"] });
});

test("the dock opens and closes windows in a fixed order, and the last open window stays", () => {
  assert.ok(desk, "src/room/desk.ts exists");
  assert.deepEqual(desk.dockItems(SHELL_ON).map((d) => d.id), ["terminal", "files", "points"]);
  assert.deepEqual(desk.dockItems(NESTED_ON).map((d) => d.id), ["terminal", "files", "points", "screen"]);
  assert.deepEqual(desk.dockItems(NESTED_ON).map((d) => d.label), ["Terminal", "Files", "Points", "Screen"]);
  assert.deepEqual(desk.toggleWindow(["terminal", "files"], "files"), ["terminal"]);
  assert.deepEqual(desk.toggleWindow(["terminal"], "terminal"), ["terminal"], "one window stays open");
  assert.deepEqual(desk.toggleWindow(["terminal"], "points"), ["terminal", "points"]);
  // where they sit: the primary window on the left, the rest stacked on the right
  assert.deepEqual(desk.deskLayout(["terminal", "files", "points"]), { primary: "terminal", side: ["files", "points"] });
  assert.deepEqual(desk.deskLayout(["screen", "terminal", "files", "points"]), { primary: "screen", side: ["terminal", "files", "points"] });
  assert.deepEqual(desk.deskLayout(["files", "points"]), { primary: null, side: ["files", "points"] });
  assert.deepEqual(desk.deskLayout(["commands", "points"]), { primary: "commands", side: ["points"] });
});

test("inside the terminal every key goes to the shell except F6, and the phone key row sends real keys", () => {
  assert.ok(desk, "src/room/desk.ts exists");
  assert.equal(desk.leavesTerminal({ type: "keydown", key: "F6" }), true);
  assert.equal(desk.leavesTerminal({ type: "keyup", key: "F6" }), false);
  for (const key of ["Escape", "Tab", "1", "F5"]) assert.equal(desk.leavesTerminal({ type: "keydown", key }), false, key);
  assert.equal(desk.phoneKey("Esc"), "\x1b");
  assert.equal(desk.phoneKey("Tab"), "\t");
  assert.equal(desk.phoneKey("Up"), "\x1b[A");
  assert.equal(desk.phoneKey("Down"), "\x1b[B");
  assert.equal(desk.phoneKey("Right"), "\x1b[C");
  assert.equal(desk.phoneKey("Left"), "\x1b[D");
  assert.equal(desk.withCtrl("c"), "\x03");
  assert.equal(desk.withCtrl("D"), "\x04");
  assert.equal(desk.withCtrl("ab"), "ab", "only a single key takes Ctrl");
  // the full terminal opens only on the computer running Rooks; a phone gets the last lines and a command row
  for (const h of ["localhost", "127.0.0.1", "127.0.1.1", "::1", "[::1]"]) assert.equal(desk.isLoopbackHost(h), true, h);
  for (const h of ["192.168.1.20", "rooks.local", "example.com", ""]) assert.equal(desk.isLoopbackHost(h), false, h);
  assert.equal(desk.plainTail("\x1b[32mok\x1b[0m\nhalf\rdone\r\n\x1b]7777;0\x07$ "), "ok\ndone\n$ ", "the phone's box shows the words, not the codes");
  assert.equal(desk.toTermText("a\nb\r\nc"), "a\r\nb\r\nc");
  assert.equal(desk.pickActive([{ id: "a", alive: false }, { id: "b", alive: true }], null), "b", "the first open terminal shows");
  assert.equal(desk.pickActive([{ id: "a", alive: false }, { id: "b", alive: true }], "a"), "a", "the one picked stays picked");
  assert.equal(desk.pickActive([{ id: "a", alive: false }], "gone"), "a");
  assert.equal(desk.pickActive([], "gone"), null);
  assert.equal(desk.cdCommand(""), 'cd "$HOME"');
  assert.equal(desk.cdCommand("Desktop/hermes"), `cd "$HOME"/'Desktop/hermes'`);
  assert.equal(desk.cdCommand("it's here"), `cd "$HOME"/'it'\\''s here'`, "a quote in a name cannot break out");
});

test("the Files window lists folders first, then files, A to Z, dotfiles last, in plain words", () => {
  assert.ok(desk, "src/room/desk.ts exists");
  const entries = [
    { name: ".profile", kind: "file", size: 230 }, { name: "notes.txt", kind: "file", size: 2048 }, { name: "hermes", kind: "folder", size: null },
    { name: "Desktop", kind: "folder", size: null }, { name: ".cache", kind: "folder", size: null }, { name: "out", kind: "link", size: null },
  ];
  assert.deepEqual(desk.sortEntries(entries).map((e) => e.name), ["Desktop", "hermes", "notes.txt", "out", ".cache", ".profile"]);
  assert.equal(desk.entryMeta({ kind: "folder", size: null }), "folder");
  assert.equal(desk.entryMeta({ kind: "link", size: null }), "link");
  assert.equal(desk.entryMeta({ kind: "file", size: 2048 }), "2 KB");
  assert.equal(desk.entryMeta({ kind: "file", size: 0 }), "0 bytes");
  assert.equal(desk.entryMeta({ kind: "file", size: 3 * 1024 * 1024 }), "3 MB");
  const now = new Date(2026, 10, 7, 18, 0);
  assert.equal(desk.whenWords(new Date(2026, 10, 7, 14, 2).toISOString(), now), "today 14:02");
  assert.equal(desk.whenWords(new Date(2026, 10, 3, 9, 0).toISOString(), now), "3 Nov");
  assert.equal(desk.whenWords("", now), "");
  assert.deepEqual(desk.crumbs(""), [{ label: "Home", path: "" }]);
  assert.deepEqual(desk.crumbs("Desktop/hermes"), [{ label: "Home", path: "" }, { label: "Desktop", path: "Desktop" }, { label: "hermes", path: "Desktop/hermes" }]);
  assert.equal(desk.parentOf("Desktop/hermes"), "Desktop");
  assert.equal(desk.parentOf("Desktop"), "");
  assert.equal(desk.joinPath("", "Desktop"), "Desktop");
  assert.equal(desk.joinPath("Desktop", "hermes"), "Desktop/hermes");
});

// ---------------------------------------------------------------------------------------------- 25: the words
test("the Room's new words: off keeps everything, a shell that stays, an ended terminal said honestly", () => {
  assert.ok(words, "src/room/words.ts exists");
  assert.equal(words.offLine({ screen: false }), "The Room is off. Everything in it is kept.");
  assert.match(words.offLine({ screen: true }), /^The Room is off\. Everything in it is kept\./);
  assert.equal(words.STOPPED_LINE, "The Room is off. Everything in it is kept.");
  assert.equal(words.terminalLabel(), "A shell inside the Room. What you install here stays.");
  assert.equal(words.endedLine("restart"), "The app restarted, so this terminal ended. Your files and anything you installed are still here.");
  assert.equal(words.endedLine("exited"), "This terminal ended. Its files are still in the Room.");
  assert.equal(words.endedLine(null), "This terminal ended. Its files are still in the Room.");
  assert.equal(words.closeCount(2), "2 terminals will close.");
  assert.equal(words.closeCount(1), "1 terminal will close.");
  assert.equal(words.closeCount(0), "");
  assert.match(words.tailLine(), /this computer/);
  assert.equal(words.tailLine(), "This phone shows the terminal's last lines and sends what you type. Open the Room on this computer for the full terminal.");
  assert.equal(words.fullLine(4), "Four terminals can be open in the Room. Close one to open another.");
  assert.equal(words.TIMEOUT_NOTE, "Stopped after 120 seconds. For something long, start it in a Room terminal.");
  assert.equal(words.elapsedWords(184), "3 min");
  assert.equal(words.elapsedWords(20), "under a minute");
  assert.equal(words.elapsedWords(3 * 3600 + 120), "3 h 2 min");
  assert.equal(words.doneWords(0), "Done (code 0)");
  assert.equal(words.terminalLine({ name: "Rooks", owner: "rooks", alive: true, busy: true, elapsed_s: 184 }), "Rooks · running, 3 min");
  assert.equal(words.terminalLine({ name: "Terminal 1", owner: "person", alive: true, busy: false }), "Terminal 1 · yours");
  assert.equal(words.terminalLine({ name: "Rooks", owner: "rooks", alive: false, exit_code: 0 }), "Rooks · ended, code 0");
  assert.match(words.commandsLabel(true), /A terminal needs the Room on this computer\./);
  assert.equal(words.commandsLabel(false), "One command at a time, up to two minutes each.");
  // the honest line is unchanged
  assert.equal(words.HONEST_LINE, "Commands run as you, in a folder of its own. It is not a locked off computer.");
  for (const w of [words.offLine({}), words.terminalLabel(), words.endedLine("restart"), words.tailLine(), words.fullLine(4), words.TIMEOUT_NOTE, words.commandsLabel(true)]) {
    assert.doesNotMatch(w, /driver|namespace|pty|oauth|mcp|utc|workbench|https?:|cli:/i, w);
  }
});

// ---------------------------------------------------------------------------------------------- the status store
test("the terminal list comes from the service on every refresh, never from the browser", () => {
  assert.ok(store?.roomFromWire, "status.ts exports roomFromWire");
  const s = store.roomFromWire({
    available: true, running: true, terminal_max: 4, can: { terminal: true, files: true },
    terminals: [
      { id: "a1b2c3d4", name: "Terminal 1", owner: "person", alive: true, busy: false, started: "2026-11-07T14:02:11Z", exit_code: null, ended_reason: null, command: null, elapsed_s: 184 },
      { id: "e5f6a7b8", name: "Rooks", owner: "rooks", alive: false, busy: false, exit_code: 0, ended_reason: "restart" },
      { name: "no id" }, null,
    ],
  });
  assert.deepEqual(s.terminals.map((t) => t.id), ["a1b2c3d4", "e5f6a7b8"], "an entry without an id is dropped");
  assert.equal(s.terminals[1].owner, "rooks");
  assert.equal(s.terminals[1].alive, false);
  assert.equal(s.terminal_max, 4);
  assert.deepEqual(s.can, { terminal: true, files: true });
  const old = store.roomFromWire({ available: true, running: true });
  assert.deepEqual(old.terminals, []);
  assert.equal(old.terminal_max, 4);
  assert.deepEqual(old.can, { terminal: false, files: false }, "a service that says nothing can do nothing new");
  // the Commands window's lines live in the store, so leaving the page and coming back keeps them for the session
  store.addCommandLines([{ kind: "cmd", text: "ls" }]);
  store.receiveRoomStatus({ available: true, running: true });
  assert.deepEqual(store.getRoomStatus().commandLines, [{ kind: "cmd", text: "ls" }]);
  const src = read("../src/room/status.ts");
  assert.doesNotMatch(src, /localStorage|sessionStorage/, "the terminal list is never remembered by the browser");
  assert.match(src, /terminals/);
});

// ---------------------------------------------------------------------------------------------- 26: source guards
test("the page is a desk under a Room bar with a dock of windows, solid, and the terminal window keeps its keys honest", () => {
  const page = maybe("../src/room/RoomPage.tsx");
  assert.ok(page, "src/room/RoomPage.tsx exists");
  assert.match(page, /<TerminalSlot kind="room"/, "the Room's panes are drawn by the keeper over this slot");
  assert.match(page, /role="toolbar" aria-label="Windows"/, "the dock is a toolbar named Windows");
  assert.match(page, /aria-pressed=/, "each dock item says whether its window is open");
  assert.match(page, /role="toolbar" aria-label="The Room"/, "the Room bar is the one toolbar with verbs");
  assert.match(page, /windowsFor\(/);
  assert.match(page, /dockItems\(/);
  assert.match(page, /One window stays open/);
  assert.match(page, /commandViewLine\(status\)/, "the honest line sits on the dock");
  assert.match(page, /isolationWords\(status\.isolation, !!status\.offline\)/);
  assert.doesNotMatch(page, /\bglass\b/, "nothing on the Room page is glass");
  for (const w of ["Advanced", "Close every terminal", "Save a point", "Start over", "Hand off a file", "Watch beside the chat"]) assert.match(page, new RegExp(w), w);

  const css = strip(maybe("../src/room/room.css"));
  assert.ok(css, "src/room/room.css exists");
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "no hex literal: every colour is a token");
  assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla)\(/, "no colour functions either");
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (/room-dock/.test(rule[1])) assert.doesNotMatch(rule[2], /--color-primary/, `${rule[1].trim()}: the dock is never a primary fill`);
  }
  for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)) assert.match(m[1], /^(none\b|ui-fade\b)/, `only the one fade: ${m[1]}`);
  for (const cls of [".room-bar", ".room-desk", ".room-dock", ".room-window", ".room-term", ".room-tail", ".room-keys"]) assert.ok(css.includes(cls), `${cls} is drawn`);

  const win = maybe("../src/room/TerminalWindow.tsx");
  assert.ok(win, "src/room/TerminalWindow.tsx exists");
  assert.match(win, /Skip the terminal/);
  const at = win.indexOf("attachCustomKeyEventHandler(");
  assert.ok(at > -1, "the pane keeps one key for itself");
  const handler = win.slice(at, at + 400);
  assert.match(handler, /leavesTerminal\(/, "F6 only (desk.leavesTerminal)");
  assert.doesNotMatch(handler, /Escape/, "Escape is never taken from the shell");
  assert.match(win, /F6 leaves the terminal/);
  assert.match(win, /screenReaderMode: true/);
  assert.match(win, /cursorBlink: motionLevel\(\) !== "off"/, "no blinking cursor when motion is off");
  assert.match(win, /disableStdin/, "Rooks's busy terminal takes no keys until it is taken");
  assert.match(win, /Take this one/);
  assert.match(win, /\/room\/terminals\/\$\{[^}]+\}\/send/, "the phone command row posts to the same shell");
  assert.match(win, /\/tail\?lines=/);
  assert.match(win, /\(pointer: coarse\)/, "the key row is for touch");
  assert.match(win, /\/api\/room\/terminals\/\$\{[^}]+\}\/ws/);
  assert.match(win, /replay/);
  assert.doesNotMatch(win, /localStorage/, "terminals, names and order are the service's");

  const files = maybe("../src/room/FilesWindow.tsx");
  assert.ok(files, "src/room/FilesWindow.tsx exists");
  assert.match(files, /\/room\/files\?path=/);
  assert.match(files, /Up one folder/);
  assert.match(files, /Show in terminal/);
  assert.match(files, /Nothing here yet\./);
  assert.match(files, /The folder could not be read\./);
  const points = maybe("../src/room/PointsWindow.tsx");
  assert.ok(points, "src/room/PointsWindow.tsx exists");
  assert.match(points, /Yes, start over/);
  assert.match(points, /Keep it/);
  assert.match(points, /closeCount\(/, "the confirm names how many terminals close");
  assert.match(points, /No saved points yet\./);
});

// ---------------------------------------------------------------------------------------------- 27: the keeper
test("the Room's terminals stay mounted through a keyed keeper, and the app's Terminal page uses the same Shell", () => {
  const host = read("../src/terminalHost.tsx");
  assert.match(host, /export function TerminalSlot\(\{ kind/, "TerminalSlot takes a kind");
  assert.match(host, /export function RoomTerminalKeeper/);
  assert.match(host, /"app"/);
  assert.match(host, /"room"/);
  const app = read("../src/App.tsx");
  assert.match(app, /<TerminalKeeper \/>/);
  assert.match(app, /<RoomTerminalKeeper \/>/);
  assert.match(read("../src/pages/TerminalPage.tsx"), /import \{[^}]*\bShell\b[^}]*\} from "\.\.\/terminal\/Shell"/);
  const shell = maybe("../src/terminal/Shell.tsx");
  assert.ok(shell, "src/terminal/Shell.tsx exists");
  assert.match(shell, /export function Shell\(/);
  assert.match(shell, /\burl\b/);
  assert.match(shell, /\breplay\b/);
  assert.match(shell, /"scrollback"/, "a replayed scrollback resets the screen and writes it once");
  assert.match(shell, /term\.reset\(\)/);
  const stage = maybe("../src/room/RoomStage.tsx");
  assert.match(stage, /<TerminalSlot kind="room"/, "the Stage shows the very same panes");
});
