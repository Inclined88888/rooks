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
