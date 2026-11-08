// The workplace cleanup (docs/architecture.md, section g.1): pages and screens that were removed stay removed, and no
// route, link, menu or "beside" entry anywhere in the app points at a page that does not exist.
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

const REMOVED = ["pages/Customize.tsx", "chat/tabs/SkillsTab.tsx", "memory/Improved.tsx"];

test("the removed screens are gone and nothing imports them", () => {
  for (const f of REMOVED) {
    assert.ok(!existsSync(join(SRC, f)), `${f} is deleted`);
    const stem = f.split("/").pop().replace(/\.tsx$/, "");
    for (const s of SOURCES) {
      assert.doesNotMatch(s.text, new RegExp(`from "[./]*[^"]*/${stem}"|import\\("[./]*[^"]*/${stem}"\\)`), `${s.path} imports ${stem}`);
    }
  }
  for (const s of SOURCES) assert.doesNotMatch(s.text, /\bImprovedCard\b|\bSkillsTab\b/, `${s.path} still names a removed screen`);
});

// Every path the app can show: the registry's pages (and their detail paths) plus the routes App.tsx answers itself.
const registry = read("pages/registry.ts");
const pageBlock = registry.slice(registry.indexOf("export const PAGES"), registry.indexOf("export const REDIRECTS"));
const redirectBlock = registry.slice(registry.indexOf("export const REDIRECTS"));
const pagePaths = [...pageBlock.matchAll(/path: "([^"]+)"/g)].map((m) => m[1]);
const alsoPaths = [...pageBlock.matchAll(/also: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
const ownRoutes = [...read("App.tsx").matchAll(/location\.pathname === "([^"]+)"/g)].map((m) => m[1]);
const SHOWN = [...pagePaths, ...alsoPaths, ...ownRoutes];

function resolves(target) {
  const path = target.replace(/[?#].*$/, "").replace(/\/$/, "") || "/";
  return SHOWN.some((p) => {
    if (p === path) return true;
    const re = new RegExp(`^${p.replace(/:[a-z]+/g, "[^/]+")}$`);
    return re.test(path);
  });
}

test("every redirect lands on a page that exists, and old Customize and Connect links land on Settings", () => {
  const redirects = [...redirectBlock.matchAll(/\{ from: "([^"]+)", to: "([^"]+)" \}/g)].map((m) => ({ from: m[1], to: m[2] }));
  assert.ok(redirects.length >= 5, "redirects parsed");
  for (const r of redirects) assert.ok(r.to === "/" || resolves(r.to), `redirect ${r.from} -> ${r.to} lands on no page`);
  assert.deepEqual(redirects.find((r) => r.from === "/connect")?.to, "/settings");
  assert.deepEqual(redirects.find((r) => r.from === "/customize")?.to, "/settings");
  assert.ok(!pagePaths.includes("/customize"), "/customize is no longer a page");
});

test("no link, menu entry or navigation in the app points at a page that does not exist", () => {
  const bad = [];
  const patterns = [
    /\bto="(\/[^"]*)"/g, // <Link to="/x">, <Go to="/x">
    /\bto: "(\/[^"]*)"/g, // { to: "/x" } in lists (skipped inside REDIRECTS, checked above)
    /\bhref="(\/(?!api\/)[^"]*)"/g, // <a href="/x">, not the API
    /\bnavigate\("(\/[^"]*)"/g, // navigate("/x")
    /\bnavigate\(`(\/[^`$]*)/g, // navigate(`/x/${id}`): the fixed start
    /\bpath: "(\/[^"]*)"/g, // menus that name a page path (the Beside list)
  ];
  for (const s of SOURCES) {
    const text = s.path === "pages/registry.ts" ? "" : s.text; // the registry is the list of pages itself
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        let target = m[1];
        if (re.source.includes("navigate\\(`")) {
          // a template: "/code/" + id matches "/code/:id"; "/plan" + query matches "/plan"
          target = target.endsWith("/") ? `${target}x` : target;
        }
        if (!resolves(target)) bad.push(`${s.path}: ${target}`);
      }
    }
  }
  assert.deepEqual(bad, [], "links to pages that do not exist");
});
