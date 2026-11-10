// Unit tests for the learn page helpers (src/learn/text.ts): `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const out = await build({ entryPoints: [new URL("../src/learn/text.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", write: false });
const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "learn.mjs", out.outputFiles[0].text);
const t = await import(pathToFileURL(dir + "learn.mjs").href);

test("step text shows values in place of {params}", () => {
  assert.deepEqual(t.stepParts("In Client, type {client} now", { client: "Bluegum Homes" }),
    [{ text: "In Client, type " }, { text: "Bluegum Homes", param: "client" }, { text: " now" }]);
  assert.deepEqual(t.stepParts("Type {due_date}"), [{ text: "Type " }, { text: "due date", param: "due_date" }]);
  assert.deepEqual(t.stepParts("Click Save"), [{ text: "Click Save" }]);
});

test("run status and missing values read in plain English", () => {
  assert.equal(t.runLabel("needs_you"), "Waiting for your OK");
  assert.equal(t.runFinished("done"), true);
  assert.equal(t.runFinished("running"), false);
  assert.deepEqual(t.missingValues([{ name: "client" }, { name: "amount" }], { client: "Bluegum", amount: " " }).map((p) => p.name), ["amount"]);
});

test("recorded events become short lines and never show hidden values", () => {
  assert.equal(t.eventLine({ kind: "click", target: { role: "button", name: "Send reminder" } }), "Clicked “Send reminder”");
  assert.equal(t.eventLine({ kind: "type", secret: true, value: "x", target: { label: "Password" } }), "Filled “Password” (hidden)");
  assert.equal(t.eventLine({ kind: "type", value: "Bluegum", target: { label: "Client" } }), "Typed “Bluegum” in “Client”");
  assert.equal(t.eventLine({ kind: "open_app", app: "Excel" }), "Working in Excel");
  assert.equal(t.eventLine({ kind: "open_app", app: "Excel", title: "Budget.xlsx" }), "Working in Excel · Budget.xlsx");
});
