// The address bar: what you typed becomes an address or a search. Plain http only for a computer on this network
// (the same addresses policy.isLocal and the Python receipts call local); the web always gets https first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalise, HOME } = require("../address.js");

test("a computer on this network opens over plain http, the web over https", () => {
  for (const s of ["localhost", "localhost:3000/x", "127.0.0.1", "10.0.0.1:8080", "192.168.1.5", "172.16.0.5", "172.31.255.1:81/p",
    "169.254.1.1", "[::1]", "[::1]:8000/y", "[fe80::1]", "printer.local", "nas.internal", "app.localhost:5173"]) {
    assert.equal(normalise(s), "http://" + s, s);
  }
  for (const s of ["example.com", "172.32.0.1", "8.8.8.8", "en.wikipedia.org/wiki/X", "shop.example.com:8443/cart", "[2001:4860::1]"]) {
    assert.equal(normalise(s), "https://" + s, s);
  }
});

test("a full address is kept as typed, words become a search, nothing is home", () => {
  assert.equal(normalise(" https://example.com/a?b=1 "), "https://example.com/a?b=1");
  assert.equal(normalise("http://example.com"), "http://example.com");  // typed on purpose; main.js remembers the host
  assert.equal(normalise("about:blank"), "about:blank");
  assert.equal(normalise("blue widget price"), "https://duckduckgo.com/?q=blue%20widget%20price");
  assert.equal(normalise("intranet"), "https://duckduckgo.com/?q=intranet");  // one word is a search, not a host
  assert.equal(normalise(""), HOME);
  assert.equal(normalise(null), HOME);
});
