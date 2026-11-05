// Connect is sign-in, a key you already have, and a tool. The protocol name stays off this screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const connect = read("../src/pages/ConnectSection.tsx");
const settings = read("../src/pages/Settings.tsx");
const mail = read("../src/pages/ConnectMailCalendar.tsx");

test("Connect is one settings section with sign-in, a key, and a tool from GitHub", () => {
  assert.match(settings, /label: "Connect"/);
  assert.match(settings, /<ConnectSection/);
  assert.match(connect, /A key you already have/);
  assert.match(connect, /Another service/);
  assert.match(connect, /From GitHub/);
  assert.match(connect, /api\("\/providers"/);
  assert.match(connect, /nothing is installed until you approve it/i);
  assert.match(mail, /Google/);
  assert.match(mail, /Microsoft/);
  assert.match(mail, /Apple/);
  assert.match(connect, /ConnectMailCalendar/);
});

test("the Connect screen does not name the tool protocol", () => {
  assert.doesNotMatch(connect, /MCP|Model Context Protocol/);
  assert.doesNotMatch(connect, /stdio|streamable/i);
});
