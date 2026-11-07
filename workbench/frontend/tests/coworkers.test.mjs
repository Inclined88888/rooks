// Unit tests for the Coworkers page helpers (src/pages/coworkersLogic.ts): `npm test`. feat/coworkers
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const out = await build({ entryPoints: [new URL("../src/pages/coworkersLogic.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false });
const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "coworkers.mjs", out.outputFiles[0].text);
const t = await import(pathToFileURL(dir + "coworkers.mjs").href);

const card = { requester: "Office manager", action: "x", reads: "r", changes: "c", result: "o", risks: "k", choices: [] };
const proposal = {
  region: "Brisbane", costs: "", integrations: [],
  professions: [{
    id: "construction", label: "Construction and trades", pack: "trade",
    team: [
      { key: "office", name: "Office manager", title: "t", instructions: "i", role: "coordinator", monthly_budget_cents: 500, include: false },
      { key: "quotes", name: "  Jo  ", title: "t", instructions: "i", role: "coworker", monthly_budget_cents: "250.4" },
      { key: "crew", name: "Crew", title: "t", instructions: "i", role: "coworker", monthly_budget_cents: -3, include: false },
    ],
    schedules: [
      { key: "morning_mail", name: "m", cron: "", plain_time: "", agent: "office", needs: [], missing: [], card },
      { key: "friday_invoices", name: "f", cron: "", plain_time: "", agent: "accounts", needs: [], missing: [], card, include: false },
    ],
  }],
};

test("one apply body per profession, with the owner's edits", () => {
  const [b] = t.proposalChoices(proposal);
  assert.equal(b.profession, "construction");
  assert.equal(b.region, "Brisbane");
  assert.deepEqual(b.team.map((m) => [m.key, m.name, m.include, m.monthly_budget_cents]),
    [["office", "Office manager", true, 500], ["quotes", "Jo", true, 250], ["crew", "Crew", false, 0]]);
  assert.deepEqual(b.schedules, [{ key: "morning_mail", include: true }, { key: "friday_invoices", include: false }]);
});

test("the coordinator cannot be dropped, and instructions are never sent from the page", () => {
  const [b] = t.proposalChoices(proposal);
  assert.equal(b.team[0].include, true);
  assert.ok(b.team.every((m) => m.instructions === ""));  // the server keeps the reviewed instructions
});

test("the Coworkers page is on the page registry and shows no technical words on its normal screen", () => {
  const reg = readFileSync(new URL("../src/pages/registry.ts", import.meta.url), "utf8");
  assert.match(reg, /path: "\/coworkers"/);
  const page = readFileSync(new URL("../src/pages/Coworkers.tsx", import.meta.url), "utf8");
  const shown = page.replace(/\/\/.*$/gm, "").replace(/import .*$/gm, "");
  for (const word of ["MCP", "OAuth", "cron", "UTC", "Workbench", "api/"]) {
    assert.ok(!new RegExp(`["'>\`][^"'<\`]*\\b${word.replace("/", "\\/")}`).test(shown), `"${word}" appears in a string on the page`);
  }
});
