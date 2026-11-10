// Room terminals on Windows (docs/design/0011-windows.md, section 1): PowerShell by default, Git Bash in the New
// terminal menu when Git for Windows is there, each terminal saying which shell it is, and Advanced saying what is
// read and how a command's end reaches Rooks. The pure modules run through esbuild; the components are read as source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

async function load(rel, name) {
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false });
  const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}

const words = await load("../src/room/words.ts", "room-windows-words.mjs");
const store = await load("../src/room/status.ts", "room-windows-status.mjs");

const WIN = {
  available: true, running: true, screen: false, pointer: false, isolation: "none",
  can: { terminal: true, files: true, terminal_off_reason: null, terminal_shells: ["powershell", "bash", "fish"] },
  terminals: [{ id: "a1b2c3d4", name: "Terminal 1", owner: "person", alive: true, busy: false, shell_kind: "powershell" }],
  terminal_max: 4,
};

test("status keeps the kinds of terminal a Room on Windows offers, and which shell each terminal is", () => {
  const s = store.roomFromWire(WIN);
  assert.deepEqual(s.can.terminal_shells, ["powershell", "bash"], "only the kinds the app knows");
  assert.equal(s.terminals[0].shell_kind, "powershell");
  const posix = store.roomFromWire({ ...WIN, can: { terminal: true, files: true }, terminals: [] });
  assert.deepEqual(posix.can.terminal_shells, [], "elsewhere the person's own login shell, no menu");
});

test("the kinds have plain names", () => {
  assert.equal(words.shellName("powershell"), "PowerShell");
  assert.equal(words.shellName("bash"), "Git Bash");
  assert.equal(words.shellName("zsh"), "zsh");
  assert.equal(words.shellName(null), "");
});

test("New terminal opens PowerShell, and a menu beside it offers Git Bash only when it is there", () => {
  const view = read("../src/room/RoomView.tsx");
  assert.match(view, /const newTerminal = \(shell\?: TerminalShell\)/, "newTerminal takes the kind");
  assert.match(view, /body: shell \? \{ shell \} : \{\}/, "and sends it only when one was picked");
  const win = read("../src/room/TerminalWindow.tsx");
  assert.match(win, /label=\{KINDS_LABEL\}/, "the menu has a plain label");
  assert.match(win, /status\.can\.terminal_shells\.length > 1/, "shown only when there is more than one kind");
  assert.equal(words.KINDS_LABEL, "Choose a kind of terminal");
});

test("Advanced says what a Windows terminal reads and how a command's end reaches Rooks", () => {
  const page = read("../src/room/RoomPage.tsx");
  assert.match(page, /WINDOWS_PROFILE_LINE/);
  assert.match(page, /WINDOWS_MARKER_LINE/);
  assert.match(words.WINDOWS_PROFILE_LINE, /PowerShell/);
  assert.match(words.WINDOWS_MARKER_LINE, /only your account can open/);
  for (const line of [words.WINDOWS_PROFILE_LINE, words.WINDOWS_MARKER_LINE, words.KINDS_LABEL]) {
    assert.doesNotMatch(line, /ConPTY|OSC|pipe\\|UTC|MCP|OAuth/, "plain words");
  }
});

// Design 0011, section 3: on Windows every Room program is in a job. The words say what that is and is not.
test("on Windows the Room says its programs are kept together, and that it is still not locked off", () => {
  const s = store.roomFromWire({ ...WIN, containment: "job" });
  assert.equal(s.containment, "job");
  assert.equal(store.roomFromWire({ ...WIN, containment: "anything" }).containment, "none", "only what the app knows");
  assert.equal(store.roomFromWire(WIN).containment, "none");
  const line = words.commandViewLine(s);
  assert.equal(line, words.WINDOWS_HONEST_LINE);
  assert.match(line, /Windows keeps them together, so they all stop when the Room stops/);
  assert.match(line, /It is not a locked off computer: they can read and change your files/);
  assert.equal(words.commandViewLine({ isolation: "none", note: "" }), words.HONEST_LINE, "elsewhere the old line");
  assert.equal(words.isolationWords("none"), "Not locked off", "the badge never oversells a job");
});

test("Advanced on Windows says what the job does and what it does not", () => {
  const page = read("../src/room/RoomPage.tsx");
  assert.match(page, /status\.containment === "job"/);
  assert.match(page, /containmentLine\(/);
  const said = words.containmentLine(false);
  assert.match(said, /stop when the Room stops or Rooks closes/);
  assert.match(said, /clipboard/);
  assert.match(said, /not a wall/i);
  assert.match(said, /your Windows sign-in/);
  assert.match(said, /still find your own/);
  assert.match(words.containmentLine(true), /a closed door, not a wall/);
  assert.doesNotMatch(words.containmentLine(false), /a closed door/);
  for (const l of [said, words.containmentLine(true), words.WINDOWS_HONEST_LINE]) {
    assert.doesNotMatch(l, /job object|JOB_|DPAPI|AppContainer|UTC|MCP|OAuth/, "plain words");
  }
});
