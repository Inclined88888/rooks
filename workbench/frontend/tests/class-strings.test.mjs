// A class string built from a template must keep one space between its parts. A search-and-replace in the design pass
// turned `team-task ${status} ${risky}` into `team-task  ${status}${risky}`, so a risky task rendered the class
// "doingrisky" and lost both its styles, and the weekend "today" column became "nowwkend". Nothing in the type check
// or the build sees that; this does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const SRC = new URL("../src/", import.meta.url).pathname;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (p.endsWith(".tsx")) yield p;
  }
}

test("every className template keeps single spaces between its parts", () => {
  const bad = [];
  for (const f of files(SRC)) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/className=\{`([^`]*)`\}/g)) {
      const tpl = m[1];
      const line = text.slice(0, m.index).split("\n").length;
      // two spaces in a row, or a space pushed inside the interpolation so two classes run together: `${a}${b}` is fine
      // only when the second part carries its own leading space (`${x ? " open" : ""}`)
      const runTogether = /\}\$\{[^}]*"[A-Za-z_]/.test(tpl) && !/\}\$\{[^}]*" /.test(tpl);
      if (tpl.includes("  ") || runTogether) bad.push(`${f.replace(SRC, "")}:${line}: ${tpl}`);
    }
  }
  assert.deepEqual(bad, []);
});
