// Keyboard first and pages that open at once (docs/design/0003-workroom.md, section 6, principles 4 and 5): one list of
// shortcuts for the command menu, the shortcuts sheet and the shell; every page and action in the command menu; page
// chunks warmed before the click; the last answer per page kept in memory; and every page the app links to has a route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));

// Pages are loaded by dynamic import: keep them out of the test bundle; stylesheets are empty here.
const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /.*/ }, (a) => (a.kind === "dynamic-import" ? { path: a.path, external: true } : undefined));
  b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "css" }));
  b.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
} };

async function load(rel, name) {
  if (!exists(rel)) return null;
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false,
    plugins: [stub], jsx: "automatic", define: { "import.meta.env.DEV": "false" } });
  const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}

const keys = await load("../src/lib/shortcuts.ts", "kb-shortcuts.mjs");
const registry = await load("../src/pages/registry.ts", "kb-registry.mjs");
const warm = await load("../src/pages/warm.ts", "kb-warm.mjs");
const cache = await load("../src/lib/cache.ts", "kb-cache.mjs");

const press = (key, o = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...o });
const field = { tagName: "INPUT", type: "text" };

test("one shortcut list: g then a letter goes to a page, never while typing", () => {
  assert.ok(keys?.createKeyReader, "src/lib/shortcuts.ts exists");
  const read_ = keys.createKeyReader();
  for (const [letter, to] of [["c", "/assistant"], ["r", "/room"], ["j", "/jobs"], ["t", "/tasks"], ["m", "/mail"], ["s", "/settings"]]) {
    assert.equal(read_(press("g"), 0), null);
    assert.equal(read_(press(letter), 100)?.to, to, `g then ${letter}`);
  }
  assert.equal(read_(press("g", { target: field }), 0), null);
  assert.equal(read_(press("c", { target: field }), 100), null, "typing g c in a box types");
  assert.equal(read_(press("g"), 0), null);
  assert.equal(read_(press("c"), 2000), null, "the second key waits only a moment");
  assert.equal(read_(press("g", { target: { tagName: "TEXTAREA" } }), 0), null);
  assert.equal(read_(press("c"), 100), null, "a g typed in the composer does not arm the next key");
});

test("? opens the shortcuts sheet, ⌘K/Ctrl+K the menu (also from a box), ⌘⇧O a new chat", () => {
  const r = keys.createKeyReader();
  assert.equal(r(press("?", { shiftKey: true }), 0)?.id, "shortcuts");
  assert.equal(r(press("?", { shiftKey: true, target: field }), 0), null, "? types in a box");
  assert.equal(r(press("k", { metaKey: true }), 0)?.id, "palette");
  assert.equal(r(press("k", { ctrlKey: true, target: field }), 0)?.id, "palette");
  assert.equal(r(press("O", { metaKey: true, shiftKey: true }), 0)?.id, "new-chat");
  assert.equal(r(press("o", { ctrlKey: true }), 0), null, "Ctrl+O alone is not a new chat");
  assert.equal(r(press("Escape"), 0), null, "Esc belongs to the chat and to sheets, not the shell");
  assert.equal(keys.isShortcut("stop", press("Escape")), true);
  assert.equal(keys.isShortcut("focus-composer", press("/", { ctrlKey: true })), true);
  assert.equal(keys.keyHint(keys.shortcut("new-chat"), true), "⌘⇧O");
  assert.equal(keys.keyHint(keys.shortcut("new-chat"), false), "Ctrl+Shift+O");
  assert.equal(keys.keyHint(keys.shortcut("go-room"), false), "G then R");
});

test("every Go to shortcut lands on a registered page", () => {
  for (const s of keys.SHORTCUTS.filter((x) => x.to)) assert.ok(registry.pageAt(s.to), `${s.id} → ${s.to}`);
});

test("the command menu, the shortcuts sheet and the shell all read the one list", () => {
  const palette = read("../src/Palette.tsx");
  const sheet = read("../src/shell/ShortcutsSheet.tsx");
  const app = read("../src/App.tsx");
  assert.match(palette, /from "\.\/lib\/shortcuts"/);
  assert.match(palette, /keys: shortcutForPath\(p\.to\)/, "a page's shortcut shows beside it");
  assert.match(palette, /className="palette-keys"/, "keys on the right of the action");
  assert.match(sheet, /SHORTCUTS\.filter\(\(s\) => s\.group === g\)/, "the sheet lists every shortcut by group");
  assert.match(app, /createKeyReader\(\)/, "the shell reads the same list");
  assert.match(app, /<ShortcutsSheet \/>/);
  assert.match(read("../src/shell/MoreSheet.tsx"), /openShortcuts\(\)/, "the More sheet lists the shortcuts too");
  for (const s of keys.SHORTCUTS) assert.doesNotMatch(s.label, /\b(MCP|OAuth|URL|UTC|Workbench)\b/, "plain words");
});

test("the command menu offers every action and every Settings section", () => {
  const palette = read("../src/Palette.tsx");
  for (const id of ["new-chat", "new-task", "new-note", "room-start", "room-stop", "room-terminal", "room-point", "room-over", "room-files", "needs-you", "search-chats", "search-everything", "shortcuts"]) {
    assert.match(palette, new RegExp(`id: "${id}"`), id);
  }
  assert.match(palette, /id: "room-terminal", label: "Open a terminal in the Room"/);
  assert.match(palette, /\.\.\.THEMES\.map/, "light, dark, high contrast and match my computer");
  assert.match(read("../src/appearance.tsx"), /id: "contrast"/);
  assert.match(palette, /\.\.\.SETTINGS_SECTIONS\.map/, "every Settings section");
  assert.match(palette, /keys: shortcut\("new-chat"\)/);
  assert.match(palette, /keys: shortcut\("shortcuts"\)/);
  assert.match(palette, /\/conversations\?q=/, "Search chats searches the chats");
  assert.match(palette, /\/knowledge\/search\?q=/, "and everything Rooks keeps");
  assert.match(read("../src/App.tsx"), /palettePages\(status\)/, "every page from the registry");
});

test("pages are warmed before the click and render at once when warm", async () => {
  assert.ok(warm?.warmEntry, "src/pages/warm.ts exists");
  let loads = 0;
  const Fake = () => null;
  const entry = { path: "/fake", label: "Fake", icon: null, load: async () => { loads += 1; return { default: Fake }; } };
  assert.equal(warm.pageComponent(entry).ready, false);
  await Promise.all([warm.warmEntry(entry), warm.warmEntry(entry), warm.warmEntry(entry)]);
  assert.equal(loads, 1, "one fetch however often it is warmed");
  const c = warm.pageComponent(entry);
  assert.equal(c.ready, true, "a warm page renders without a Suspense step");
  assert.equal(c.C, Fake);
  assert.equal(warm.entryFor("/assistant/12")?.path, "/assistant");
  assert.equal(warm.entryFor("/settings?section=models")?.path, "/settings");
  assert.equal(warm.entryFor("/packs/trade?doc=3")?.path, "/packs/trade");
  for (const f of ["../src/shell/Rail.tsx", "../src/shell/MoreSheet.tsx", "../src/shell/MobileBar.tsx"]) assert.match(read(f), /warmProps\(/, `${f} warms on hover and focus`);
  assert.match(read("../src/Palette.tsx"), /warmPath\(to\)/, "the command menu warms the selected page");
  const app = read("../src/App.tsx");
  assert.match(app, /<Suspense fallback=\{<PageFrameLoading entry=\{entry\} \/>\}>/, "a cold page shows its frame and Loading, not a blank screen");
  assert.match(app, /warmWhenIdle\(SHORTCUTS\.flatMap/, "the pages the keyboard jumps to are fetched once the app is idle");
});

test("the last answer per page is kept in memory and asked again in the background", async () => {
  assert.ok(cache?.loadCached, "src/lib/cache.ts exists");
  cache.clearCached();
  let asks = 0;
  const loader = async () => { asks += 1; return [{ id: asks }]; };
  assert.equal(cache.peekCached("tasks"), undefined);
  const [a, b] = await Promise.all([cache.loadCached("tasks", loader), cache.loadCached("tasks", loader)]);
  assert.equal(asks, 1, "two parts asking at once share one request");
  assert.deepEqual(a, b);
  assert.deepEqual(cache.peekCached("tasks"), [{ id: 1 }], "kept for the next visit");
  await cache.loadCached("tasks", loader);
  assert.deepEqual(cache.peekCached("tasks"), [{ id: 2 }], "the next visit refreshes it");
  assert.match(read("../src/v02/Jobs.tsx"), /useCached<Board>\("jobs:board"/);
  assert.match(read("../src/pages/Tasks.tsx"), /peekCached<Task\[\]>\("tasks"\)/);
  assert.match(read("../src/pages/Assistant.tsx"), /peekCached<\{ messages: Row\[\]; model: string \}>\(`conv:\$\{cid\}`\)/, "a chat opened again shows at once");
});

test("every page the app links to has a route: the packs, and Extra tools away from the service's own /mcp", () => {
  for (const p of ["/packs", "/packs/legal", "/packs/study", "/packs/trade", "/extra-tools"]) assert.ok(registry.pageAt(p), `${p} is a page`);
  assert.ok(registry.morePages(null).some((g) => g.pages.some((p) => p.path === "/packs")), "Packs is in the More sheet");
  assert.ok(!registry.pageAt("/mcp") && !registry.pageAt("/tools"), "no page where the service answers a reload itself");
  assert.ok(registry.REDIRECTS.some((r) => r.from === "/mcp" && r.to === "/extra-tools"), "an old /mcp link still lands on Extra tools");
  assert.ok(!registry.REDIRECTS.some((r) => r.from.startsWith("/packs") && r.to === "/assistant"), "the packs no longer bounce to Chat");
  // the pages a pack links to are the ones it declares
  for (const id of ["legal", "study", "trade"]) {
    const pack = JSON.parse(readFileSync(new URL(`../../backend/app/packs/bundles/${id}/pack.json`, import.meta.url), "utf8"));
    assert.ok(registry.pageAt(pack.page), `${id} pack page ${pack.page}`);
  }
  for (const f of ["../src/pages/Settings.tsx", "../src/pages/ConnectSection.tsx"]) assert.doesNotMatch(read(f), /to[=:] ?"\/mcp"/, f);
  const main = readFileSync(new URL("../../backend/app/main.py", import.meta.url), "utf8");
  assert.match(main, /path\.startswith\(\("api\/", "tools\/", "mcp", "v1\/"\)\)/, "the service keeps /mcp and /tools for itself");
});
