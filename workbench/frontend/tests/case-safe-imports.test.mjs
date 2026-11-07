// Windows and macOS file systems ignore case. An import of "./settings" (a folder) next to "Settings.tsx" resolves to
// the folder on Linux but to the file on Windows and macOS, which broke the desktop builds in CI. Any import of a folder
// that has a same-named file beside it, differing only in case, must name the folder's index explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const EXT = [".ts", ".tsx", ".mjs", ".js"];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

test("no relative import is ambiguous on a case insensitive file system", () => {
  const bad = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const spec = m[1];
      const target = resolve(dirname(file), spec);
      const parent = dirname(target);
      const base = target.slice(parent.length + 1);
      let siblings;
      try { siblings = readdirSync(parent); } catch { continue; }
      const isDir = siblings.includes(base) && statSync(join(parent, base)).isDirectory();
      if (!isDir) continue;
      const clash = siblings.filter((s) => s !== base && EXT.some((e) => s.toLowerCase() === base.toLowerCase() + e));
      if (clash.length) bad.push(`${file.slice(SRC.length + 1)} imports "${spec}" next to ${clash.join(", ")}`);
    }
  }
  assert.deepEqual(bad, []);
});
