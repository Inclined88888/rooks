// The browser's site rules must give the same answers as rooks_browser/policy.py, or the agent would be allowed
// somewhere in our own browser that it is refused in Chrome. policy_cases.json is written from the Python code by
// make_policy_cases.py; run it again whenever policy.py changes:  cd rooks-browser && python app/test/make_policy_cases.py
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const policy = require("../policy.js");
const cases = JSON.parse(readFileSync(new URL("./policy_cases.json", import.meta.url), "utf8"));

test("local and private addresses: same answers as Python's is_local", () => {
  for (const [host, want] of Object.entries(cases.is_local)) assert.equal(policy.isLocal(host), want, host);
});

test("allow, deny and service mode: same verdicts and reasons as SitePolicy.check", () => {
  for (const [p, url, [ok, why]] of cases.check) {
    const [gotOk, gotWhy] = policy.check(p, url);
    assert.equal(gotOk, ok, `${JSON.stringify(p)} ${url}`);
    assert.equal(gotWhy, why, `${JSON.stringify(p)} ${url}`);
  }
});

test("a lookalike domain is never local", () => {
  for (const h of ["fcbarcelona.com", "fd.example", "localhost.evil.com"]) assert.equal(policy.isLocal(h), false, h);
});
