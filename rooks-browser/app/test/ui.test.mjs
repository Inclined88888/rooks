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
import net from "node:net";

const require = createRequire(import.meta.url);
const APP = new URL("..", import.meta.url).pathname;
let electron = null;
try { ({ _electron: electron } = require("playwright")); } catch { /* skipped below */ }
const ready = electron && existsSync(join(APP, "node_modules", "electron"));
const skip = !ready && "electron or playwright not installed";

function serve() {
  const pages = {
    "/": "<title>Home page</title><h1>Home</h1><a href='/next'>Next</a>",
    "/next": "<title>Next page</title><p>Second page</p>",
  };
  const s = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(pages[req.url] || "nope"); });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

function closedPort() {  // a port nothing listens on: a page there cannot open
  return new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
}

async function launch(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rb-ui-"));
  const env = { ...process.env, ROOKS_BROWSER_APP_DATA: join(dir, "data"), ROOKS_BROWSER_CONTROL_FILE: join(dir, "control.json"),
    ROOKS_BROWSER_CMD: JSON.stringify(["false"]),  // no task helper unless a test says otherwise: the panel must say so plainly
    ...extraEnv };
  delete env.NODE_OPTIONS;
  const args = [APP];
  if (process.getuid && process.getuid() === 0) { env.ROOKS_BROWSER_TEST_NO_SANDBOX = "1"; args.push("--no-sandbox"); }
  const app = await electron.launch({ args, env, executablePath: require(join(APP, "node_modules", "electron")) });
  const ui = await app.firstWindow();
  for (let i = 0; i < 100 && !existsSync(env.ROOKS_BROWSER_CONTROL_FILE); i += 1) await new Promise((r) => setTimeout(r, 100));
  const control = JSON.parse(readFileSync(env.ROOKS_BROWSER_CONTROL_FILE, "utf8"));
  return { app, ui, control, dir };
}

const api = (c, method, path, body) => fetch(c.url + path, { method, body: body ? JSON.stringify(body) : undefined,
  headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" } }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function tabPage(app, prefix) {  // the page shown in a tab (Playwright lists the tab views as windows)
  for (let i = 0; i < 100; i += 1) {
    const w = app.windows().find((x) => x.url().startsWith(prefix));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no tab showing ${prefix}`);
}

test("browse, private tabs, the panel, and Stop", { skip }, async () => {
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

    // A page that does not open: the address stays the one that failed and the lock says so, never "Secure" and
    // never the data: address of the app's own "could not open" page
    const gone = `http://127.0.0.1:${await closedPort()}/`;
    await ui.fill("#url", gone);
    await ui.press("#url", "Enter");
    await ui.waitForSelector("#lock:text('Could not open')");
    assert.equal(await ui.inputValue("#url"), gone);
    assert.equal(await ui.textContent(".tab.active .title"), "Could not open");

    // A private tab is marked, and the panel refuses to hand it to a model
    await ui.click("#newprivate");
    await ui.waitForSelector(".tab.private.active");
    const privateId = Number(await ui.getAttribute(".tab.private.active", "data-id"));
    await ui.click("#toggle");
    assert.equal(await ui.isVisible("#panel"), true);
    await ui.waitForSelector("#helper.warn");  // the helper command was "false": said plainly, buttons off
    assert.equal(await ui.isDisabled("button[data-mode='do']"), true);
    assert.equal(await ui.textContent("#helper"), "The task helper stopped.");  // plain words on the page...
    assert.equal(await ui.textContent("#helperdetail"), "exit code 1");            // ...the code under Details

    // The control channel refuses a private tab too, and never takes the one in front when it is private
    const refused = await api(control, "POST", "/agent/start", { policy: {}, tab: privateId });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.detail, "Tasks do not run in private tabs.");
    const fresh = await api(control, "POST", "/agent/start", { policy: {} });  // the private tab is active: a new normal tab instead
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.body.tab, privateId);
    await ui.waitForSelector(".tab.active:not(.private) .ai-badge");
    assert.equal(await ui.locator(".tab.private .ai-badge").count(), 0);
    await api(control, "POST", "/agent/end", {});

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

test("a permission the person granted a site is still denied in the agent's tab", { skip }, async () => {
  const site = await serve();
  const base = `http://127.0.0.1:${site.address().port}`;
  // As if the person had clicked "Allow this time" for this site earlier in the run
  const { app, ui, control } = await launch({ ROOKS_BROWSER_TEST_GRANTS: JSON.stringify([`${base} notifications`]),
    ROOKS_BROWSER_CMD: JSON.stringify(["/nonexistent/rooks-browser"]) });
  try {
    await ui.fill("#url", `${base}/`);
    await ui.press("#url", "Enter");
    const page = await tabPage(app, base);
    assert.equal(await page.evaluate("Notification.permission"), "granted");  // in the person's own tab the grant holds
    const start = await api(control, "POST", "/agent/start", { policy: {}, new_tab: true });
    assert.equal(start.status, 200);
    assert.equal((await api(control, "POST", "/tab/open", { url: `${base}/` })).status, 200);
    const read = await api(control, "POST", "/tab/eval", { fn: "() => Notification.permission" });
    assert.equal(read.body.result, "denied");  // the same site, the agent's tab: no
    const asked = await api(control, "POST", "/tab/eval", { fn: "() => Notification.requestPermission()" });
    assert.equal(asked.body.result, "denied");
    await api(control, "POST", "/agent/end", {});

    // A helper that is not there: said in plain words, the code under Details
    await ui.click("#toggle");
    await ui.waitForSelector("#helper.warn");
    assert.equal(await ui.textContent("#helper"), "The task helper is not installed. Run the Rooks installer.");
    assert.equal(await ui.textContent("#helperdetail"), "ENOENT");
  } finally {
    await app.close();
    site.close();
  }
});

test("the task helper gets no secrets from the app's environment, and its errors reach the panel in plain words", { skip }, async () => {
  const dump = join(mkdtempSync(join(tmpdir(), "rb-env-")), "helper-env.json");
  const { app, ui, control } = await launch({
    ROOKS_BROWSER_CMD: JSON.stringify([process.execPath, join(APP, "test", "fake_helper.mjs"), dump]),
    // what the app's own process may hold: the app's secrets, model keys and tokens meant for other programs
    APP_SECRET: "app-secret-value", TOOLS_API_KEY: "tools-key-value", OPENAI_API_KEY: "sk-not-for-the-helper",
    GITHUB_TOKEN: "gh-token-value", WEBHOOK_SECRET: "hook-secret-value", DB_PASSWORD: "db-password-value",
    ROOKS_BROWSER_TOKEN: "a-stale-token-from-another-run", ROOKS_BROWSER_HOME: "/tmp/rooks-home-for-this-test",
  });
  try {
    assert.equal(control.helper_error, "");
    const env = JSON.parse(readFileSync(dump, "utf8"));
    for (const k of ["APP_SECRET", "TOOLS_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "WEBHOOK_SECRET", "DB_PASSWORD"]) {
      assert.equal(k in env, false, `${k} reached the helper`);
    }
    assert.equal(env.ROOKS_BROWSER_TOKEN, control.helper_token);  // its own token, not the stale one
    for (const k of ["PATH", "HOME"]) assert.ok(env[k], `${k} missing`);
    assert.equal(env.ROOKS_BROWSER_HOME, "/tmp/rooks-home-for-this-test");  // ordinary settings pass through
    assert.equal(JSON.stringify(env).includes("value"), false);

    // A job that ends in an error: the panel says so plainly; the helper's own text is under Details
    await ui.click("#toggle");
    await ui.waitForSelector("#helper:not(.warn)");
    await ui.fill("#goal", "Find the cheapest widget");
    await ui.click("button[data-mode='do']");
    await ui.waitForSelector("#runtitle:text('Did not finish')");
    assert.match(await ui.textContent("#answer"), /^The task ran into a problem and did not finish\./);
    assert.equal((await ui.textContent("#answer")).includes("RuntimeError"), false);
    assert.match(await ui.textContent("#answerdetail"), /RuntimeError: could not read the page/);
  } finally {
    await app.close();
  }
});
