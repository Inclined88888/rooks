// The browser's own interface, driven like a person would: tabs, private tabs, the address bar, the Ask Rooks panel,
// and Stop taking the tab back from a running task. Uses Playwright's Electron support (test only; the shipped app
// never opens a debugging port). Skipped without the electron package or Playwright.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const require = createRequire(import.meta.url);
const APP = new URL("..", import.meta.url).pathname;
let electron = null;
try { ({ _electron: electron } = require("playwright")); } catch { /* skipped below */ }
const ready = electron && existsSync(join(APP, "node_modules", "electron"));

function serve() {
  const pages = {
    "/": "<title>Home page</title><h1>Home</h1><a href='/next'>Next</a>",
    "/next": "<title>Next page</title><p>Second page</p>",
  };
  const s = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(pages[req.url] || "nope"); });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

async function launch() {
  const dir = mkdtempSync(join(tmpdir(), "rb-ui-"));
  const env = { ...process.env, ROOKS_BROWSER_APP_DATA: join(dir, "data"), ROOKS_BROWSER_CONTROL_FILE: join(dir, "control.json"),
    ROOKS_BROWSER_CMD: JSON.stringify(["false"]) };  // no task helper: the panel must say so plainly
  delete env.NODE_OPTIONS;
  const args = [APP];
  if (process.getuid && process.getuid() === 0) { env.ROOKS_BROWSER_TEST_NO_SANDBOX = "1"; args.push("--no-sandbox"); }
  const app = await electron.launch({ args, env, executablePath: require(join(APP, "node_modules", "electron")) });
  const ui = await app.firstWindow();
  for (let i = 0; i < 100 && !existsSync(env.ROOKS_BROWSER_CONTROL_FILE); i += 1) await new Promise((r) => setTimeout(r, 100));
  const control = JSON.parse(readFileSync(env.ROOKS_BROWSER_CONTROL_FILE, "utf8"));
  return { app, ui, control };
}

const api = (c, method, path, body) => fetch(c.url + path, { method, body: body ? JSON.stringify(body) : undefined,
  headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("browse, private tabs, the panel, and Stop", { skip: !ready && "electron or playwright not installed" }, async () => {
  const site = await serve();
  const base = `http://127.0.0.1:${site.address().port}`;
  const { app, ui, control } = await launch();
  try {
    // The address bar: a local address opens; the tab title follows the page
    await ui.fill("#url", `${base}/`);
    await ui.press("#url", "Enter");
    await ui.waitForSelector(".tab.active .title:text('Home page')");
    assert.equal(await ui.inputValue("#url"), `${base}/`);
    assert.equal(await ui.textContent("#lock"), "Not secure");  // plain http is labelled, even on this computer

    // A private tab is marked, and the panel refuses to hand it to a model
    await ui.click("#newprivate");
    await ui.waitForSelector(".tab.private.active");
    await ui.click("#toggle");
    assert.equal(await ui.isVisible("#panel"), true);
    await ui.waitForSelector("#helper.warn");  // the helper command was "false": said plainly, buttons off
    assert.equal(await ui.isDisabled("button[data-mode='do']"), true);

    // Stop: a running task's tab comes back to the person
    await ui.click(".tab:not(.private)");
    const start = await api(control, "POST", "/agent/start", { policy: {} });
    assert.equal(start.status, 200);
    await ui.waitForSelector("#driving:not([hidden])");
    await ui.waitForSelector(".tab.active .ai-badge");
    await ui.click("#stop");
    await ui.waitForSelector("#driving", { state: "hidden" });
    const st = await api(control, "GET", "/agent/state");
    assert.equal(st.body.stopped, true);
    assert.equal(st.body.reason, "You stopped it.");
    assert.equal((await api(control, "POST", "/tab/eval", { fn: "() => 1" })).status, 409);  // the agent cannot act any more

    // Typing in the address bar while a task runs is a takeover too
    await api(control, "POST", "/agent/end", {});
    assert.equal((await api(control, "POST", "/agent/start", { policy: {} })).status, 200);
    await ui.fill("#url", `${base}/next`);
    await ui.press("#url", "Enter");
    await ui.waitForSelector(".tab.active .title:text('Next page')");
    assert.equal((await api(control, "GET", "/agent/state")).body.reason, "You took over.");
  } finally {
    await app.close();
    site.close();
  }
});
