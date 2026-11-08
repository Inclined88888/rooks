// UI polish from the design review (web-design-guidelines and impeccable, November 2026). Each test failed on the code
// before its fix: no PIN screen, the Room's run-on subtitle and repeated verbs, the faint chat box focus, the phone chat
// header, and the phone browser bar colour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const cacheDir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
mkdirSync(cacheDir, { recursive: true });
const out = await build({ bundle: true, format: "esm", platform: "node", write: false, entryPoints: [fileURLToPath(new URL("../src/room/words.ts", import.meta.url))] });
writeFileSync(cacheDir + "polish-words.mjs", out.outputFiles[0].text);
const words = await import(pathToFileURL(cacheDir + "polish-words.mjs").href);

// ---------------------------------------------------------------------------------------------- no PIN screen
test("a new server install has no PIN to set: it opens with a sign-in link", () => {
  const auth = read("../src/pages/Auth.tsx");
  assert.doesNotMatch(auth, /Set a PIN or password/, "the PIN setup screen is gone");
  assert.doesNotMatch(auth, /api\("\/setup"/, "nothing posts a new PIN");
  assert.match(auth, /Open your sign-in link/);
  assert.match(auth, /signin=expired/, "a spent link says so");
  assert.match(auth, /status\.pin_login/, "a PIN is offered only where someone set one");
  assert.match(auth, /<Advanced[^>]*>[\s\S]*python -m app\.signin[\s\S]*<\/Advanced>/, "the server command sits under Advanced only");
});

test("Settings makes a sign-in link for another device instead of changing a password", () => {
  const settings = read("../src/pages/Settings.tsx");
  assert.doesNotMatch(settings, /At least 10 characters/, "no password rule that differs from setup");
  assert.doesNotMatch(settings, /Change password/);
  assert.match(settings, /api<[^>]*>\("\/signin\/link"/);
  assert.match(settings, /Make a sign-in link/);
});

// ---------------------------------------------------------------------------------------------- the Room
test("the Room's label and note read as two sentences", () => {
  assert.equal(words.labelLine("A private desktop on this computer", "A screen of its own on this computer."),
    "A private desktop on this computer. A screen of its own on this computer.");
  assert.equal(words.labelLine("Done.", "Next."), "Done. Next.", "no double full stop");
  assert.equal(words.labelLine("", "Only a note."), "Only a note.");
  const page = read("../src/room/RoomPage.tsx");
  assert.match(page, /label=\{labelLine\(status\.label, status\.note\)\}/);
  assert.doesNotMatch(page, /\[status\.label, status\.note\]\.filter\(Boolean\)\.join\(" "\)/);
});

test("on the desktop Room page each verb shows once: the bar's", () => {
  const page = read("../src/room/RoomPage.tsx");
  assert.match(page, /useRoomScreen\(status, narrow \? \(\) => void act\.start\(\) : null/, "the Screen window's Start only on phones");
  assert.match(page, /<TerminalWindow [^>]*startFromBar=\{!narrow\}/, "and the Terminal window's");
  assert.match(page, /const pointsShown = !narrow && shown\.includes\("points"\)/);
  assert.match(page, /!pointsShown && status\.available && <Verb icon=\{<Bookmark size=\{13\} \/>\} word="Save a point"/, "the bar's Save a point steps aside for the window's");
  assert.equal(words.offStartLine("screen", true), "Press Start at the top to see its screen.");
  assert.equal(words.offStartLine("terminal", true), "Press Start at the top to open a terminal.");
  assert.equal(words.offStartLine("screen"), "Start it to see its screen.", "the Stage and phones keep their own button and line");
});

// ---------------------------------------------------------------------------------------------- chat
test("the chat box shows focus as clearly as every other field", () => {
  const css = strip(read("../src/styles.css"));
  // both the plain composer and the Workroom chat's (which is the one on screen, and more specific)
  for (const sel of ["\\.composer", "\\.shell-agents \\.agents-composer"]) {
    const rule = css.match(new RegExp(`(?:^|\\})\\s*${sel}:focus-within\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `${sel}:focus-within exists`);
    assert.match(rule[1], /border-color:\s*var\(--color-border-focus\)/, sel);
    assert.match(rule[1], /box-shadow:\s*0 0 0 1px var\(--color-border-focus\)/, sel);
  }
});

test("on a phone the chat header stays on one row and the chip row shows there is more", () => {
  const css = strip(read("../src/chat/chat.css"));
  assert.doesNotMatch(css, /\.chat-top\.agents-thread-top\s*\{\s*flex-wrap:\s*wrap/, "the top row no longer wraps the ⋯ onto its own line");
  assert.match(css, /\.chat-top \.agents-local-pill\s*\{\s*display:\s*none/, "the pill steps aside on phones");
  assert.match(css, /\.chat-chips\s*\{[^}]*mask-image:\s*linear-gradient/, "the chip row fades at its end");
});

// ---------------------------------------------------------------------------------------------- the browser bar
test("phone browsers colour their bar to match the app", () => {
  const html = read("../index.html");
  assert.match(html, /<meta name="theme-color" content="#FAFAF9" media="\(prefers-color-scheme: light\)"/);
  assert.match(html, /<meta name="theme-color" content="#161616" media="\(prefers-color-scheme: dark\)"/);
  const sync = read("../src/themeSync.ts");
  assert.match(sync, /theme-color/, "a theme picked in the app updates the bar too");
});

test("an empty chat starts at its greeting, not scrolled past it", () => {
  const page = read("../src/pages/Assistant.tsx");
  const follow = page.slice(page.indexOf("if (!pinnedRef.current) return;") - 40, page.indexOf('block: "end" });'));
  assert.match(follow, /if \(!messages\.length && !live\) return;/, "nothing to follow yet: the phone keeps the greeting in view");
});
