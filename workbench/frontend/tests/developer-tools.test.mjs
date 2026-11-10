// Developer tools behind one switch (docs/architecture.md, section g.3). Workplace teams do not see the Terminal, Code,
// coding jobs, Fine-tune, Compare, the run log, Insights, Status, Extra tools, the packs or links to other AI front ends
// in the rail, its flyouts, the More sheet or the command menu. Settings, Advanced has one switch, "Show developer
// tools", off on a new install and kept by the install (the server). With it on, every one of them is listed again.
// Their addresses open either way, and Chat's Plan and Build coding modes show only with the switch on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const stub = { name: "stub", setup(b) {
  b.onResolve({ filter: /.*/ }, (a) => (a.kind === "dynamic-import" ? { path: a.path, external: true } : undefined));
  b.onResolve({ filter: /\.css$/ }, (a) => ({ path: a.path, namespace: "css" }));
  b.onLoad({ filter: /.*/, namespace: "css" }, () => ({ contents: "", loader: "js" }));
} };

async function load(rel, name) {
  if (!existsSync(new URL(rel, import.meta.url))) return null;
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false,
    plugins: [stub], jsx: "automatic", define: { "import.meta.env.DEV": "false" } });
  const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}

const registry = await load("../src/pages/registry.ts", "dev-registry.mjs");
const devTools = await load("../src/lib/devTools.ts", "dev-tools.mjs");

// Every developer page, by address. The packs' own pages have no section, so they live only in the command menu.
const IN_MORE = ["/code", "/terminal", "/fine-tune", "/compare", "/runs", "/insights", "/status", "/extra-tools", "/packs"];
const HIDDEN = [...IN_MORE, "/packs/legal", "/packs/study", "/packs/trade"];

// Both helpers running, so nothing is missing only because of an add-on.
const OFF = { browser_enabled: true, desk_enabled: true };
const ON = { ...OFF, dev_tools: true };
const LINKS = { chat_url: "http://127.0.0.1:3000", paperclip_url: "http://127.0.0.1:3100", hermes_url: "http://127.0.0.1:8642" };

function listed(s) {
  const rail = registry.railItems(s).flatMap((i) => i.pages.map((p) => p.path));
  const more = registry.morePages(s).flatMap((g) => g.pages.map((p) => p.path));
  const palette = registry.palettePages(s).map((p) => p.path);
  return { rail, more, palette, all: new Set([...rail, ...more, ...palette]) };
}

test("with the switch off, no developer page is in the rail, a flyout, the More sheet or the command menu", () => {
  for (const s of [OFF, null, { ...OFF, dev_tools: false }]) {
    const { all } = listed(s);
    for (const p of HIDDEN) assert.ok(!all.has(p), `${p} is hidden (${JSON.stringify(s)})`);
  }
  // what a workplace team uses stays where it was
  const { rail, more, palette } = listed(OFF);
  for (const p of ["/assistant", "/room", "/jobs", "/mail", "/calendar", "/tasks", "/files"]) assert.ok(rail.includes(p), `${p} on the rail`);
  for (const p of ["/home", "/automations", "/research", "/meetings", "/history", "/plan", "/privacy"]) assert.ok(more.includes(p), `${p} in More`);
  assert.ok(palette.includes("/settings"));
});

test("with the switch on, every developer page is listed again, under Advanced", () => {
  const { more, palette } = listed(ON);
  for (const p of IN_MORE) assert.ok(more.includes(p), `${p} in the More sheet`);
  for (const p of HIDDEN) assert.ok(palette.includes(p), `${p} in the command menu`);
  const advanced = registry.morePages(ON).find((g) => g.section === "Advanced");
  for (const p of IN_MORE) assert.ok(advanced.pages.some((x) => x.path === p), `${p} sits under Advanced`);
});

test("their addresses still open, switch or no switch", () => {
  for (const p of HIDDEN) assert.ok(registry.pageAt(p), `${p} has a route`);
  for (const p of HIDDEN) assert.ok(registry.PAGES.find((x) => x.path === p).dev, `${p} is marked as a developer page`);
  const app = read("../src/App.tsx");
  assert.match(app, /PAGES\.flatMap\(\(p\) => \[p\.path, \.\.\.\(p\.also \?\? \[\]\)\]/, "routes come from every page, not the visible ones");
});

test("links to Open WebUI, Paperclip and Hermes show only with the switch on", () => {
  assert.deepEqual(registry.externalLinks({ ...OFF, ...LINKS }), []);
  assert.deepEqual(registry.externalLinks({ ...ON, ...LINKS }).map((l) => l.label), ["Open WebUI", "Paperclip", "Hermes agent"]);
  assert.deepEqual(registry.externalLinks(ON), [], "no link without an address");
  const sheet = read("../src/shell/MoreSheet.tsx");
  assert.match(sheet, /externalLinks\(status\)/);
  assert.doesNotMatch(sheet, /status\??\.(paperclip_url|hermes_url|chat_url)/, "the sheet does not read the addresses itself");
  const settings = read("../src/pages/Settings.tsx");
  assert.match(settings, /devTools && s\?\.chat_url/, "Settings shows Open WebUI only with the switch on");
});

test("Chat's Plan and Build coding modes, the Code item and Continue in terminal show only with the switch on", () => {
  assert.equal(devTools.chatMode("build", false), "chat");
  assert.equal(devTools.chatMode("plan", false), "chat");
  assert.equal(devTools.chatMode("build", true), "build");
  assert.equal(devTools.chatMode("chat", true), "chat");
  const head = read("../src/chat/ThreadHeader.tsx");
  assert.match(head, /\{p\.devTools && \(\s*<div className="tabs mode-tabs agents-mode-head" role="group" aria-label="Mode"/, "the Chat and Code tabs");
  assert.match(head, /\{p\.devTools && p\.workMode !== "chat" && \(/, "Plan and Build");
  assert.match(head, /\{devTools && <button type="button" role="menuitem" onClick=\{go\(\(\) => navigate\("\/code"\)\)\}>Code<\/button>\}/);
  assert.match(head, /\{devTools && cid \?/, "Continue in terminal");
  const chat = read("../src/pages/Assistant.tsx");
  assert.match(chat, /const workMode = chatMode\(savedMode, devTools\)/, "a saved Build mode does not come back while the switch is off");
});

test("the switch: Settings, Advanced, off by default, kept by the install, read once from the status answer", () => {
  assert.equal(devTools.devToolsOn(), false, "off until the server says otherwise");
  devTools.setDevTools(true);
  assert.equal(devTools.devToolsOn(), true);
  devTools.setDevTools(false);
  const settings = read("../src/pages/Settings.tsx");
  const advanced = settings.slice(settings.indexOf('section === "advanced"'));
  assert.match(advanced, /label="Show developer tools"/);
  assert.match(advanced, /<Switch checked=\{devTools\} onChange=\{setDev\}/);
  assert.match(settings, /api\("\/settings", \{ method: "PUT", body: \{ dev_tools: on \} \}\)/, "saved on the server, not in this browser");
  const tools = settings.slice(settings.indexOf('section === "tools"'), settings.indexOf('section === "skills"'));
  assert.doesNotMatch(tools, /Extra tools/, "Extra tools moved to Advanced");
  assert.match(read("../src/pages/ConnectSection.tsx"), /\{devTools && <ButtonLink size="sm" to="\/extra-tools">Add your own<\/ButtonLink>\}/, "Connect links to Extra tools only with the switch on");
  const app = read("../src/App.tsx");
  assert.match(app, /setDevTools\(!!s\.dev_tools\)/);
  assert.match(app, /dev_tools\?: boolean/);
  assert.doesNotMatch(read("../src/lib/devTools.ts"), /localStorage/, "kept by the install, not by one browser");
});
