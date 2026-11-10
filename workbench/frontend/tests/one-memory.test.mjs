// One memory (docs/architecture.md, g.2): the Memory page, About you and the chat's Memory tab were three screens over
// three stores. Now there is one store (/api/knowledge/memories) and one Memory page that adds, corrects, explains and
// forgets, with the learning switches beside it. Old links land on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const read = (p) => readFileSync(join(SRC, p), "utf8");
function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const SOURCES = files(SRC).map((p) => ({ path: p.slice(SRC.length), text: readFileSync(p, "utf8") }));

test("About you and the chat's Memory tab are gone; the Memory page is the one screen", () => {
  for (const f of ["pages/AboutYou.tsx", "chat/tabs/MemoryTab.tsx"]) assert.ok(!existsSync(join(SRC, f)), `${f} is deleted`);
  for (const s of SOURCES) assert.doesNotMatch(s.text, /\bAboutYou\b|\bMemoryTab\b/, `${s.path} still names a merged screen`);
  const registry = read("pages/registry.ts");
  const pages = registry.slice(registry.indexOf("export const PAGES"), registry.indexOf("export const REDIRECTS"));
  assert.doesNotMatch(pages, /path: "\/about-you"|path: "\/assistant-memory"/, "no page at the old addresses");
  const redirects = registry.slice(registry.indexOf("export const REDIRECTS"));
  assert.match(redirects, /\{ from: "\/about-you", to: "\/knowledge" \}/, "old About you links land on Memory");
  assert.match(redirects, /\{ from: "\/assistant-memory", to: "\/knowledge" \}/, "old chat Memory links land on Memory");
});

test("no screen reads or writes the two old stores", () => {
  for (const s of SOURCES) {
    assert.doesNotMatch(s.text, /["`]\/learn\/facts|["`]\/learn\/legacy-memories|["`]\/memories[`"/?$]/, `${s.path} calls an old memory route`);
    assert.doesNotMatch(s.text, /to="\/about-you"|navigate\("\/assistant-memory"\)|navigate\("\/about-you"\)/, `${s.path} links to a merged screen`);
  }
});

test("the Memory page adds, corrects, explains and forgets, and holds the learning switches", () => {
  const page = read("memory/Knowledge.tsx");
  assert.match(page, /Tell me something/, "add a fact by hand");
  assert.match(page, /method: "POST"|api\(`?"?\/knowledge\/memories`?"?, \{ body/, "saves to the one store");
  assert.match(page, /method: "PATCH", body: \{ content/, "correct a fact in place");
  assert.match(page, /\/knowledge\/memories\/forget-all/, "forget everything");
  assert.match(page, /\/knowledge\/memories\/\$\{m\.id\}\/why/, "why do you know this");
  assert.match(page, /\/learn\/settings/, "the learning switches moved here from About you");
  assert.match(page, /\/learn\/work/, "the work it has seen moved here");
  assert.match(page, /\/learn\/lessons/, "lessons from your changes moved here");
  for (const s of ["Learn about me as we work", "Use what I know in answers"]) assert.match(page, new RegExp(s), s);
});
