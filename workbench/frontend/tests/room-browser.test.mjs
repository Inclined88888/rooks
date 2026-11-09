// The Room's browser in the app (docs/design/0007-room-browser-and-native-app.md, sections 1.3, 1.5, 1.6 and 3): a
// Browser window on the Room's desk after Terminal, offered from the Room's status; plain words with the reason when it
// is off; the live page through the browser socket on this computer and a still with taps on a phone; copy through a
// ClipboardItem (the one form WebKit allows after a round trip) and paste from the paste event only. The pure modules
// run through esbuild; the components are read from the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));
const maybe = (p) => (exists(p) ? read(p) : "");

async function load(rel, name) {
  if (!exists(rel)) return null;
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false });
  const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}

const desk = await load("../src/room/desk.ts", "room-browser-desk.mjs");
const br = await load("../src/room/browser.ts", "room-browser-pure.mjs");
const store = await load("../src/room/status.ts", "room-browser-status.mjs");
const steps = await load("../src/plainStep.ts", "room-browser-plainstep.mjs");

const ON = { checked: true, reachable: true, available: true, running: true, screen: false, pointer: false, terminals: [], terminal_max: 4 };
const WITH = { ...ON, can: { terminal: true, files: true, browser: true, browser_off_reason: null } };
const WITHOUT = { ...ON, can: { terminal: true, files: true, browser: false, browser_off_reason: null } };

test("the Browser window is offered from the Room's status, after Terminal", () => {
  assert.ok(desk, "src/room/desk.ts exists");
  assert.deepEqual(desk.windowsFor(WITH), ["terminal", "browser", "files", "points"]);
  assert.deepEqual(desk.windowsFor(WITHOUT), ["terminal", "files", "points"], "a Room whose own screen is the way: no Browser window");
  assert.deepEqual(desk.dockItems(WITH).map((d) => d.label), ["Terminal", "Browser", "Files", "Points"]);
  for (const why of ["no_engine", "switched_off", "windows", "helper"]) {
    const off = { ...ON, can: { terminal: true, files: true, browser: false, browser_off_reason: why } };
    assert.ok(desk.windowsFor(off).includes("browser"), `${why}: the window is there to say why`);
  }
  assert.deepEqual(desk.defaultOpen(WITH), ["terminal", "files", "points"], "the browser starts only when its window is opened");
  assert.deepEqual(desk.deskLayout(["terminal", "browser", "files"]), { primary: "browser", side: ["terminal", "files"] });
  assert.equal(desk.WINDOW_TITLE.browser, "Browser");
});

test("off, the window says why in plain words", () => {
  assert.ok(br, "src/room/browser.ts exists");
  assert.equal(br.browserOff(WITH), null, "a browser here: nothing to explain");
  const words = (why) => br.browserOff({ ...ON, can: { browser: false, browser_off_reason: why } });
  assert.equal(words("no_engine").title, "The Room has no browser yet.");
  assert.match(words("no_engine").line, /Chrome|Edge|Chromium/);
  assert.equal(words("switched_off").title, "The Room's browser is switched off in Settings.");
  assert.equal(words("windows").title, "The Room's browser is not on Windows yet.");
  assert.equal(words("helper").title, "The Room runs elsewhere, so its browser is not here.");
  assert.equal(br.browserOff({ ...WITH, running: false }).title, "The Room is off. Everything in it is kept.");
  assert.equal(br.browserOff({ ...WITH, running: false }).line, "Start it to open the browser. Your tabs and sign-ins are kept.");
  for (const why of ["no_engine", "switched_off", "windows", "helper"]) {
    const w = words(why);
    assert.doesNotMatch(`${w.title} ${w.line}`, /https?:|\bid\b|OAuth|MCP|Workbench|Traceback/, why);
  }
});

test("the phone gets a still, taps and a Type field, and says what needs the computer", () => {
  assert.ok(br, "src/room/browser.ts exists");
  assert.equal(br.PHONE_LINE, "On a phone you can tap, scroll and type. Dragging, hovering and shortcuts need the computer.");
  assert.equal(br.stillMode({ loopback: false, coarse: false }), true, "not this computer: no socket");
  assert.equal(br.stillMode({ loopback: true, coarse: true }), true, "a touch screen: taps on a still");
  assert.equal(br.stillMode({ loopback: true, coarse: false }), false, "this computer: the live page");
  assert.equal(br.STILL_EVERY_MS, 2000);
  const win = maybe("../src/room/BrowserWindow.tsx");
  assert.match(win, /\/room\/browser\/frame/, "the still comes from the frame route");
  assert.match(win, /\/room\/browser\/act/, "taps, scrolls and typing go through the act route");
  assert.match(win, /PHONE_LINE/);
});

test("the live page: clicks land where they were made, keys and the wheel reach the page", () => {
  assert.ok(br, "src/room/browser.ts exists");
  // the picture is drawn at the size it shows; a click maps through the view the service reports
  assert.deepEqual(br.toViewPoint({ x: 100, y: 50 }, { width: 400, height: 300 }, { width: 800, height: 600 }), { x: 200, y: 100 });
  assert.deepEqual(br.toViewPoint({ x: -5, y: 900 }, { width: 400, height: 300 }, { width: 800, height: 600 }), { x: 0, y: 599 });
  assert.equal(br.modifiers({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: true }), 9);
  assert.deepEqual(br.keyMessage({ type: "keydown", key: "a", code: "KeyA", keyCode: 65, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }),
    { type: "key", event: "down", key: "a", code: "KeyA", text: "a", keyCode: 65, modifiers: 0 });
  assert.deepEqual(br.keyMessage({ type: "keyup", key: "Enter", code: "Enter", keyCode: 13, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }),
    { type: "key", event: "up", key: "Enter", code: "Enter", text: "", keyCode: 13, modifiers: 0 });
  const ctrlA = br.keyMessage({ type: "keydown", key: "a", code: "KeyA", keyCode: 65, altKey: false, ctrlKey: true, metaKey: false, shiftKey: false });
  assert.equal(ctrlA.text, "", "a shortcut is not a character");
  assert.equal(br.keyStaysInApp({ key: "F6" }), true, "F6 leaves the page, as in the terminal");
  assert.equal(br.keyStaysInApp({ key: "v", ctrlKey: true }), true, "paste comes from the paste event");
  assert.equal(br.keyStaysInApp({ key: "v", metaKey: true }), true);
  assert.equal(br.keyStaysInApp({ key: "a" }), false);
  // pointer events carry no click count: a double click is counted from the press before
  assert.equal(br.clickCount(null, { t: 0, x: 10, y: 10 }), 1);
  assert.equal(br.clickCount({ t: 0, x: 10, y: 10, n: 1 }, { t: 200, x: 12, y: 11 }), 2);
  assert.equal(br.clickCount({ t: 0, x: 10, y: 10, n: 2 }, { t: 300, x: 10, y: 10 }), 3);
  assert.equal(br.clickCount({ t: 0, x: 10, y: 10, n: 3 }, { t: 300, x: 10, y: 10 }), 3);
  assert.equal(br.clickCount({ t: 0, x: 10, y: 10, n: 1 }, { t: 900, x: 10, y: 10 }), 1, "too slow: a new click");
  assert.equal(br.clickCount({ t: 0, x: 10, y: 10, n: 1 }, { t: 100, x: 40, y: 10 }), 1, "too far: a new click");
  assert.equal(br.addressShown("about:blank"), "");
  assert.equal(br.addressShown("https://shop.example/a?b=1"), "https://shop.example/a?b=1", "the address bar shows the whole address");
  assert.equal(br.tabTitle({ title: "", url: "about:blank" }), "New tab");
  assert.equal(br.TABS_FULL, "Eight tabs are open. Close one to open another.");
  assert.equal(br.ROOKS_USING, "Rooks is using the browser");
});

test("copy goes through a ClipboardItem with a promise; paste only from the paste event", async () => {
  assert.ok(br, "src/room/browser.ts exists");
  const written = [];
  class FakeItem { constructor(items) { this.items = items; } }
  const clip = { write: async (items) => { written.push(items); } };
  let asked = 0;
  const ok = await br.copySelection(clip, FakeItem, () => { asked += 1; return Promise.resolve("words from the page"); });
  assert.equal(ok, true);
  assert.equal(asked, 1);
  const item = written[0][0];
  assert.ok(item instanceof FakeItem);
  const blob = await item.items["text/plain"];
  assert.equal(await blob.text(), "words from the page");
  assert.equal(await br.copySelection(null, FakeItem, () => Promise.resolve("x")), false, "no clipboard: nothing pretended");
  const win = maybe("../src/room/BrowserWindow.tsx");
  assert.match(win, /ClipboardItem/);
  assert.match(win, /addEventListener\("paste"|onPaste=/, "paste reads the paste event's text");
  assert.doesNotMatch(win, /clipboard\.readText|clipboard\.read\(/, "the Room never reads the clipboard otherwise");
});

test("the window joins the browser's socket only when the Room has a browser here, and says when Rooks uses it", () => {
  const win = maybe("../src/room/BrowserWindow.tsx");
  assert.ok(win, "src/room/BrowserWindow.tsx exists");
  assert.match(win, /\/api\/room\/browser\/ws/);
  assert.match(win, /browserOff\(/, "off: the reason, never an empty frame");
  assert.match(win, /ROOKS_USING/);
  assert.match(win, /TABS_FULL/);
  for (const label of ["Back", "Forward", "Reload", "New tab", "Address"]) assert.match(win, new RegExp(`"${label}`), label);
  const page = maybe("../src/room/RoomPage.tsx");
  assert.match(page, /BrowserWindow/);
  assert.match(page, /browser: Globe/);
});

test("status keeps whether the Room has a browser, why not, and its tabs", () => {
  assert.ok(store, "src/room/status.ts exists");
  const st = store.roomFromWire({ ...WITH, browser: { open: false, tabs: [{ id: "saved-0", url: "https://shop.example/", title: "Shop", asleep: true }] } });
  assert.equal(st.can.browser, true);
  assert.equal(st.can.browser_off_reason, null);
  assert.equal(st.browser.tabs.length, 1);
  assert.equal(store.roomFromWire({ ...ON, can: { browser: false, browser_off_reason: "no_engine" } }).can.browser_off_reason, "no_engine");
  assert.equal(store.roomFromWire({ ...ON, can: { browser: false, browser_off_reason: "made up" } }).can.browser_off_reason, null);
  assert.equal(store.roomFromWire({ ...ON }).browser.open, false);
});

test("the browser steps read the same as the presence line (presence.py _ROOM)", () => {
  assert.ok(steps);
  const say = (args) => steps.plainStep("use_room", JSON.stringify(args));
  assert.equal(say({ action: "page" }), "Looking at a page in the Room's browser");
  assert.equal(say({ action: "shot" }), "Looking at a page in the Room's browser");
  assert.equal(say({ action: "browse", address: "https://shop.example/a?x=1" }), "Opening a page in the Room's browser: shop.example");
  assert.equal(say({ action: "click" }), "Clicking in the Room's browser");
  assert.equal(say({ action: "type", text: "my secret words" }), "Typing in the Room's browser");
  assert.equal(say({ action: "tabs" }), "Checking the Room browser's tabs");
});

test("switched off, the window points to a switch that is really in Settings (review finding)", () => {
  assert.ok(br, "src/room/browser.ts exists");
  const settings = read("../src/pages/Settings.tsx");
  // the app's own screens switch the Room's browser and its terminals on and off (PUT /settings room_browser, app_terminal)
  assert.match(settings, /room_browser:\s*boolean/, "Settings reads the Room browser's switch");
  assert.match(settings, /app_terminal:\s*boolean/, "Settings reads the terminals' switch");
  assert.match(settings, /body:\s*\{\s*room_browser:/, "Settings saves the Room browser's switch");
  assert.match(settings, /body:\s*\{\s*app_terminal:/, "Settings saves the terminals' switch");
  assert.match(settings, /label="The Room's browser"/);
  assert.match(settings, /label="Terminals"/);
  // where: Settings, Tools; the window's link opens that section
  const off = br.browserOff({ ...ON, can: { browser: false, browser_off_reason: "switched_off" } });
  assert.match(off.line, /Settings, under Tools/);
  const win = read("../src/room/BrowserWindow.tsx");
  assert.match(win, /to="\/settings\?section=tools"/);
  const term = read("../src/room/TerminalWindow.tsx");
  assert.match(term, /to="\/settings\?section=tools"/);
  assert.match(term, /Settings, under Tools/);
});

test("a browser that did not start says why in plain words, with the detail only under Advanced", () => {
  assert.ok(br && store, "src/room/browser.ts and status.ts exist");
  const words = {
    no_engine: "The Room's browser could not start: no browser was found on this computer to run it.",
    refused: "The Room's browser could not start: the browser on this computer refused to start.",
    wall: "The Room's browser could not start: the wall that keeps it inside the Room could not be set up.",
  };
  for (const [reason, line] of Object.entries(words)) {
    const failed = { reason, words: line, advanced: "Exit code: 1\nLast output:\nbwrap: setting up uid map: Permission denied" };
    assert.deepEqual(br.startFailed(failed), failed, reason);
    const st = store.roomFromWire({ ...WITH, browser: { open: false, tabs: [], failed } });
    assert.deepEqual(st.browser.failed, failed, `${reason}: status keeps why the last start failed`);
    assert.doesNotMatch(br.startFailed(failed).words, /bwrap|Exit code|https?:|Traceback/, "the normal line stays plain");
  }
  assert.equal(br.startFailed(null), null);
  assert.equal(br.startFailed({ reason: "refused" }), null, "no words: nothing to say");
  assert.equal(store.roomFromWire({ ...WITH }).browser.failed, null);
  const win = maybe("../src/room/BrowserWindow.tsx");
  assert.match(win, /<details[^>]*>\s*<summary>Advanced<\/summary>/, "the detail is under Advanced");
  assert.match(win, /failed\.advanced/, "Advanced shows what was run and what it printed");
  assert.match(win, /failed\.words/, "the window shows the plain reason");
});
