// Rooks as its own program (docs/design/0007-room-browser-and-native-app.md, 2.2 and 2.4).
// * When Rooks opens in a Chrome or Edge window, or in the usual browser, because there is no Rooks app for this
//   computer, the page says so once and offers the choice; the answer goes back to the launcher.
// * WebKit (the Rooks app's webview) does not open window.open(_blank) and ignores <a download>: links leave through
//   openExternal (the system browser in the app), files through download() (the app saves to Downloads).
// * Recording the computer's sound is missing in WebKit: the page says so instead of failing quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

function sources(dir) {
  const root = fileURLToPath(new URL(dir, import.meta.url));
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = d + "/" + n;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n)) out.push([p.slice(root.length), readFileSync(p, "utf8")]);
    }
  };
  walk(root);
  return out;
}

const QUESTION = "There is no Rooks app for this computer yet. Open Rooks in a Chrome or Edge window, or in your usual browser?";
const shell = await load("../src/shellChoice.ts", "native-app-shell.mjs");

test("the shell word from the launcher decides whether the bar shows", () => {
  assert.ok(shell, "src/shellChoice.ts exists");
  const none = { get: () => null, set: () => {} };
  assert.equal(shell.barFor("?shell=ask", none)?.question, QUESTION);
  assert.equal(shell.barFor("?shell=window", none)?.question, QUESTION);
  assert.equal(shell.barFor("", none), null);
  assert.equal(shell.barFor("?shell=evil", none), null);
  // a chosen window shows the bar once; after that only the launcher's line says it
  const seen = { get: () => "1", set: () => {} };
  assert.equal(shell.barFor("?shell=window", seen), null);
  assert.equal(shell.barFor("?shell=ask", seen)?.question, QUESTION); // no answer yet: always asks
  assert.deepEqual(shell.barFor("?shell=ask", none).choices.map((c) => c.value), ["window", "browser"]);
  assert.equal(shell.withoutShell("/?shell=window&x=1"), "/?x=1");
  assert.equal(shell.withoutShell("/?shell=ask"), "/");
});

test("the bar is in the app shell and saves the answer for the launcher", () => {
  const bar = maybe("../src/shell/ShellChoiceBar.tsx");
  assert.match(bar, /\/desktop\/shell/);
  assert.match(bar, /barFor\(/);
  assert.match(read("../src/App.tsx"), /<ShellChoiceBar/);
});

test("links and files leave through the desktop bridge, never window.open(_blank)", () => {
  const desktop = read("../src/desktop.ts");
  assert.match(desktop, /export async function openExternal\(/);
  assert.match(desktop, /invoke<void>\("open_external"/);
  assert.match(desktop, /export function download\(/);
  for (const [file, text] of sources("../src")) {
    if (file.endsWith("desktop.ts")) continue;
    assert.doesNotMatch(text, /window\.open\(/, `${file} opens a window WebKit will not open`);
  }
});

test("recording the computer's sound says it needs Chrome where it is missing", () => {
  const m = read("../src/pages/Meetings.tsx");
  assert.match(m, /Recording the computer's sound needs Chrome\. The microphone works\./);
});

test("the Rooks app can open links and save files", () => {
  const caps = JSON.parse(read("../../../desktop/src-tauri/capabilities/default.json"));
  assert.ok(caps.permissions.includes("allow-open-external"));
  const buildRs = read("../../../desktop/src-tauri/build.rs");
  assert.match(buildRs, /"open_external"/);
  const lib = read("../../../desktop/src-tauri/src/lib.rs");
  assert.match(lib, /on_download/);
});
