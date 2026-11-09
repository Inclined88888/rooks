// The Room for workplace teams: a normal person sees its Files and Saved points. The Room's Terminal and Browser are
// developer tools, off on a new install: switched off means not shown (no "switched off" placeholder window, no
// Commands window in their place), and their switches in Settings, with the Browser link, show only with "Show developer
// tools" on. The line that says commands run as you shows only when terminals are on. The pure modules (the desk, the
// words, the status store) are run through esbuild; the components are read from the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));

async function load(rel, name) {
  if (!exists(rel)) return null;
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false });
  const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}

const desk = await load("../src/room/desk.ts", "room-pro-desk.mjs");
const words = await load("../src/room/words.ts", "room-pro-words.mjs");
const store = await load("../src/room/status.ts", "room-pro-status.mjs");

const ON = { checked: true, reachable: true, available: true, running: true, screen: false, pointer: false, terminals: [], terminal_max: 4 };
// what a new install's service says: a private folder, terminals and the browser switched off
const NEW_INSTALL = { ...ON, can: { terminal: false, files: true, terminal_off_reason: "switched_off", browser: false, browser_off_reason: "switched_off" } };
const DEVELOPER = { ...ON, can: { terminal: true, files: true, terminal_off_reason: null, browser: true, browser_off_reason: null } };

test("a new install's Room shows only Files and Saved points", () => {
  assert.deepEqual(desk.windowsFor(NEW_INSTALL), ["files", "points"]);
  assert.deepEqual(desk.defaultOpen(NEW_INSTALL), ["files", "points"]);
  assert.deepEqual(desk.dockItems(NEW_INSTALL).map((d) => d.label), ["Files", "Points"]);
  // the status store's own default, filled from the wire with nothing about terminals or the browser
  const wire = store.roomFromWire({ available: true, running: true, can: { files: true } });
  assert.deepEqual(desk.windowsFor({ ...wire, checked: true }), ["files", "points"]);
});

test("with terminals and the browser switched on, both windows are there", () => {
  assert.deepEqual(desk.windowsFor(DEVELOPER), ["terminal", "browser", "files", "points"]);
  assert.deepEqual(desk.dockItems(DEVELOPER).map((d) => d.label), ["Terminal", "Browser", "Files", "Points"]);
  assert.deepEqual(desk.defaultOpen(DEVELOPER), ["terminal", "files", "points"], "the browser starts only when its window is opened");
  assert.deepEqual(desk.windowsFor({ ...DEVELOPER, can: { ...DEVELOPER.can, browser: false, browser_off_reason: "switched_off" } }), ["terminal", "files", "points"]);
  assert.deepEqual(desk.windowsFor({ ...DEVELOPER, can: { ...DEVELOPER.can, terminal: false, terminal_off_reason: "switched_off" } }), ["browser", "files", "points"]);
});

test("switched off, or not possible here, means not shown: no placeholder window, no Commands in its place", () => {
  for (const why of ["switched_off", "helper", "windows", null]) {
    for (const bwhy of ["no_engine", "switched_off", "windows", "helper", null]) {
      const s = { ...ON, can: { terminal: false, files: true, terminal_off_reason: why, browser: false, browser_off_reason: bwhy } };
      assert.deepEqual(desk.windowsFor(s), ["files", "points"], `${why} / ${bwhy}`);
    }
  }
  assert.deepEqual(desk.windowsFor({ ...ON, can: undefined }), ["points"], "an older service that says nothing: only Saved points");
  // a Room with a real screen keeps its Screen window: that is the Room itself, not a developer tool
  assert.deepEqual(desk.windowsFor({ ...NEW_INSTALL, screen: true }), ["screen", "files", "points"]);
  // a remembered Terminal or Browser window is dropped when status does not offer it
  const m = new Map([["rooks.room.desk", JSON.stringify({ open: ["terminal", "browser", "commands"] })]]);
  assert.deepEqual(desk.readDesk(NEW_INSTALL, { getItem: (k) => m.get(k) ?? null }), ["files", "points"]);
});

test("the line that says commands run as you shows only when terminals are on", () => {
  assert.equal(typeof words.dockLine, "function", "words.dockLine exists");
  assert.equal(words.dockLine({ ...NEW_INSTALL, isolation: "none", note: "" }), "");
  assert.equal(words.dockLine({ ...NEW_INSTALL, isolation: "namespace", note: "" }), "");
  assert.equal(words.dockLine({ ...DEVELOPER, isolation: "none", note: "" }), words.HONEST_LINE);
  const page = read("../src/room/RoomPage.tsx");
  const view = read("../src/room/RoomView.tsx");
  assert.match(page, /dockLine\(status\)/, "the Room page's dock uses it");
  assert.match(view, /dockLine\(status\)/, "the Stage's and the phone's honest line use it");
  assert.doesNotMatch(page, /commandViewLine\(status\)/);
});

test("the Room page never opens a terminal or a Commands window that status does not offer", () => {
  const page = read("../src/room/RoomPage.tsx");
  assert.doesNotMatch(page, /\?\s*"commands"\s*:\s*id/, "Open a terminal no longer falls back to the Commands window");
  assert.match(page, /status\.can\.terminal\s*&&/, "a new terminal starts only when the Room can open one");
});

test("Settings: the Room's switches and the Browser link show only with developer tools on", () => {
  const src = read("../src/pages/Settings.tsx");
  assert.match(src, /\{devTools && \(\s*<Section title="The Room"/, "The Room section sits behind Show developer tools");
  assert.match(src, /\{devTools && <Go label="Browser"/, "the Browser link row sits behind Show developer tools");
  assert.match(src, /checked=\{s\.app_terminal === true\}/, "off unless the install says on");
  assert.match(src, /checked=\{s\.room_browser === true\}/, "off unless the install says on");
  const section = src.slice(src.indexOf('<Section title="The Room"'), src.indexOf("</Section>", src.indexOf('<Section title="The Room"')));
  assert.doesNotMatch(section, /window says so/, "switched off is not shown, so the copy does not promise a window");
});

test("the command menu offers Open a terminal in the Room only with developer tools on", () => {
  const palette = read("../src/Palette.tsx");
  assert.match(palette, /devToolsOn\(\)\s*\?\s*\[\{ id: "room-terminal"/);
});

test("the Files window offers Show in terminal, and talks about the terminal, only while terminals are on", () => {
  const files = read("../src/room/FilesWindow.tsx");
  assert.match(files, /const termsOn = status\.can\.terminal === true/);
  assert.match(files, /\{termsOn && <IconButton label=\{blocked \? `Show in terminal/, "the Show in terminal button only with terminals on");
  for (const line of ["It may have been moved or removed in the terminal.", "What you install or save in the terminal shows up here.", "Use the terminal to see more."]) {
    const at = files.indexOf(line);
    assert.ok(at > -1, line);
    assert.match(files.slice(Math.max(0, at - 40), at), /termsOn \?/, `${line} only with terminals on`);
  }
});
