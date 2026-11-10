// Rooks Browser: a private browser you use yourself, and can hand a task to (docs/design/0005-rooks-browser-app.md).
//
// Security model, in one place:
// 1. Web pages run in sandboxed views with no Node, no preload and context isolation. Only the browser's own UI page has
//    a preload, and it exposes a fixed list of messages, never Node or ipcRenderer itself.
// 2. Chromium's remote debugging port is never opened: any program on the computer could take over signed in tabs
//    through it. The agent drives a tab through the control channel below: 127.0.0.1 only, a random port, a random
//    token, and any request carrying an Origin header (a web page) is refused.
// 3. While the agent drives a tab, every request that tab makes is checked against the job's site rules (policy.js, the
//    same rules as the Python agent), and the tab cannot ask for camera, microphone, location or notifications.
// 4. Permissions are asked, never granted silently. Popups open as tabs. Plain http is upgraded to https for public
//    sites. Private tabs keep nothing after they close.
"use strict";

const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, session, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const policy = require("./policy.js");
const { normalise, HOME } = require("./address.js");

const UI_TOP = 88;            // tab strip + address bar, in CSS pixels (ui/style.css keeps the same numbers)
const SAFE_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write"]);
// The app's own secrets (workbench/backend/app/security.py APP_SECRET_ENV): never handed to the task helper's process.
const SECRET_ENV = new Set(["APP_SECRET", "TOOLS_API_KEY", "BROWSER_API_KEY", "DESK_API_KEY", "CODING_BRIDGE_KEY", "NATIVE_SIGNIN_KEY",
  "WORKBENCH_DESKTOP_TOKEN", "TRY_API_KEY", "ROOKS_TRY_API_KEY", "ROOKS_BROWSER_TOKEN", "ROOKS_DESK_TOKEN", "WORKBENCH_API_KEY",
  "BRIDGE_API_KEY"]);
const SECRET_SUFFIX = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;
// The helper is the model client: the keys its own providers read (rooks_browser/llm.py PROVIDERS) are meant for it.
const MODEL_KEYS = new Set(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]);
const ASK_PERMISSIONS = new Set(["media", "geolocation", "notifications", "midi", "midiSysex", "pointerLock", "openExternal",
  "clipboard-read", "display-capture", "idle-detection", "window-management", "speaker-selection", "storage-access"]);

if (process.env.ROOKS_BROWSER_APP_DATA) app.setPath("userData", process.env.ROOKS_BROWSER_APP_DATA);  // tests and portable use
app.commandLine.appendSwitch("disable-features", "PasswordManagerOnboarding");
if (process.env.ROOKS_BROWSER_TEST_NO_SANDBOX === "1") {
  // Tests only: CI containers run as root, where Chromium refuses its sandbox. Never set for people.
  app.commandLine.appendSwitch("no-sandbox");
} else {
  app.enableSandbox();
}

let win = null;
let panelWidth = 0;            // the side panel's width, reported by the UI
const tabs = new Map();        // id -> { id, view, private, partition, lastStatus, failed: { url, why } | null }
let activeId = null;
let nextId = 1;
let privateCount = 0;
const granted = new Map();     // `${origin} ${permission}` -> true, for this run only
const insecureOk = new Set();  // hosts the user chose to open over plain http this run
if (process.env.ROOKS_BROWSER_CONTROL_FILE && process.env.ROOKS_BROWSER_TEST_GRANTS) {
  // Tests only (they also set the control file): permissions "already granted" this run, to show the agent's tab never gets them.
  try { for (const g of JSON.parse(process.env.ROOKS_BROWSER_TEST_GRANTS)) granted.set(String(g), true); } catch { /* none */ }
}

// The agent's hold on one tab while a job runs.
let agent = null;              // { tab, policy, stopped, reason, blocked: [], downloads: [], navs: [], seq, dir, job }
let pendingJob = null;         // the job the side panel just started, until its agent claims the tab
const control = { port: 0, token: crypto.randomBytes(32).toString("hex") };
const helper = { port: 0, token: crypto.randomBytes(32).toString("hex"), proc: null, error: "", detail: "" };

/** True while the agent drives this page's tab: no permissions, every request checked, the person can take over. */
function driven(wc) {
  return Boolean(agent && !agent.stopped && wc && tabs.get(agent.tab)?.view.webContents === wc);
}

// --- tabs ------------------------------------------------------------------------------------------------------------
function partitionFor(isPrivate) {
  if (!isPrivate) return "persist:rooks";
  privateCount += 1;
  return `rooks-private-${privateCount}`;  // no "persist:": kept in memory, gone when the last tab using it closes
}

function harden(ses) {
  if (ses.__rooks) return;
  ses.__rooks = true;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = safeOrigin(details.requestingUrl || wc.getURL());
    if (SAFE_PERMISSIONS.has(permission)) return callback(true);
    if (driven(wc)) return callback(false);  // never while the agent drives
    if (granted.get(`${origin} ${permission}`)) return callback(true);
    if (!ASK_PERMISSIONS.has(permission) || !win) return callback(false);
    const what = { media: "use your camera or microphone", geolocation: "know your location", notifications: "show notifications",
      "clipboard-read": "read your clipboard", "display-capture": "see your screen", openExternal: "open another app" }[permission]
      || `use ${permission}`;
    dialog.showMessageBox(win, { type: "question", buttons: ["Block", "Allow this time"], defaultId: 0, cancelId: 0,
      message: `${origin} wants to ${what}.`, detail: "Allowed until you close Rooks Browser." })
      .then(({ response }) => {
        if (response === 1) granted.set(`${origin} ${permission}`, true);
        callback(response === 1);
      }).catch(() => callback(false));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    // A page also *reads* its permissions (Notification.permission, the Permissions API) through this handler, so a
    // permission the person granted earlier must read as denied in the agent's tab too, as the request handler says.
    if (SAFE_PERMISSIONS.has(permission)) return true;
    if (driven(wc)) return false;
    return granted.get(`${safeOrigin(origin)} ${permission}`) === true;
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const t = agent && !agent.stopped ? tabs.get(agent.tab) : null;
    if (t && details.webContentsId === t.view.webContents.id) {
      // Same split as the Chrome driver (browser.py _route): pages the agent opens get every rule; a page's own
      // resources (scripts, fonts, CDNs) are only checked against the deny list, so an allow list does not break pages.
      const isPage = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
      const [ok, why] = policy.check(isPage ? agent.policy : { deny: agent.policy.deny }, details.url);
      if (!ok) {
        if (isPage) agent.blocked.push({ seq: agent.seq++, url: details.url, why, method: details.method });
        return callback({ cancel: true });
      }
    }
    if (details.resourceType === "mainFrame" && details.url.startsWith("http://")) {
      const host = policy.hostOf(details.url);
      if (!policy.isLocal(host) && !insecureOk.has(host)) {
        return callback({ redirectURL: "https://" + details.url.slice("http://".length) });  // https first
      }
    }
    callback({});
  });
  ses.on("will-download", (_event, item, wc) => {
    const t = agent && !agent.stopped ? tabs.get(agent.tab) : null;
    if (!t || wc !== t.view.webContents) return;  // the user's own downloads: the normal save dialog
    fs.mkdirSync(agent.dir, { recursive: true });
    const base = path.basename(item.getFilename() || "download").replace(/[^\w.\- ]+/g, "_") || "download";
    let target = path.join(agent.dir, base);
    for (let i = 1; fs.existsSync(target); i += 1) target = path.join(agent.dir, `${path.parse(base).name}-${i}${path.parse(base).ext}`);
    item.setSavePath(target);
    const rec = { path: target, bytes: 0, done: false };
    agent.downloads.push(rec);
    item.once("done", (_e, state) => {
      rec.done = true;
      if (state === "completed") rec.bytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
      else rec.error = state;
    });
  });
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return String(url || ""); }
}

function newTab(url = HOME, isPrivate = false, partition = null) {
  const part = partition || partitionFor(isPrivate);
  const view = new WebContentsView({
    webPreferences: { partition: part, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false,
      safeDialogs: true, spellcheck: false },
  });
  harden(view.webContents.session);
  const id = nextId++;
  const tab = { id, view, private: isPrivate, partition: part, lastStatus: 0, failed: null };
  tabs.set(id, tab);
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) newTab(u, tab.private, tab.partition);
    return { action: "deny" };  // a page never gets a real second window
  });
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.on("did-navigate", (_e, u, code) => {
    tab.lastStatus = code || 0;
    if (tab.failed?.pending) { tab.failed.pending = false; return; }  // our "could not open" page arrived: the address stays the one that failed
    tab.failed = null;
    if (/^(data|blob):/i.test(u)) return;  // not a page the tab visited
    if (agent && agent.tab === id && !agent.stopped) agent.navs.push({ seq: agent.seq++, url: u, status: code || 0 });  // the receipt's page rows
  });
  for (const ev of ["page-title-updated", "did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page"]) {
    wc.on(ev, () => sendTabs());
  }
  wc.on("did-fail-load", (_e, code, desc, failedUrl, isMain) => {
    if (!isMain || code === -3) return;  // -3: aborted (a redirect or our own block)
    const blocked = agent && agent.tab === id && agent.blocked.length ? agent.blocked[agent.blocked.length - 1].why : "";
    tab.failed = { url: failedUrl, why: blocked || desc, pending: true };
    const page = errorPage(failedUrl, blocked || desc, !blocked && failedUrl.startsWith("https://"));
    wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`, { baseURLForDataURL: "" }).catch(() => {});
  });
  wc.on("before-input-event", (_e, input) => {  // the person types in the page while the agent works: they take over
    if (agent && agent.tab === id && !agent.stopped && Date.now() > agent.syntheticUntil && input.type === "keyDown") stopAgent("You took over.");
  });
  win.contentView.addChildView(view);
  activate(id);
  // Always load something: a view that never loaded a document has no page to run script in, and calls into it hang.
  wc.loadURL(url && url !== HOME ? normalise(url) : HOME).catch(() => {});
  return tab;
}

function errorPage(url, why, offerHttp) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><meta name="color-scheme" content="light dark"><title>Could not open</title>
<body style="font:15px system-ui;max-width:560px;margin:15vh auto;padding:0 16px">
<h1 style="font-size:22px">This page did not open</h1><p>${esc(url)}</p><p>${esc(why)}</p>
${offerHttp ? "<p>The site may not support a secure connection. You can try the address bar with http:// at your own risk.</p>" : ""}`;
}

/** The address a tab shows: the one that failed while our "could not open" page is up, never that page's data: URL. */
function shownUrl(t) {
  if (t.failed) return t.failed.url;
  const url = t.view.webContents.getURL();
  return url === HOME ? "" : url;
}

function activate(id) {
  if (!tabs.has(id)) return;
  activeId = id;
  for (const t of tabs.values()) t.view.setVisible(t.id === id);
  layout();
  sendTabs();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (agent && agent.tab === id) stopAgent("The tab was closed.");
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  tabs.delete(id);
  if (activeId === id) {
    const rest = [...tabs.keys()];
    if (rest.length) activate(rest[rest.length - 1]); else newTab();
  } else sendTabs();
}

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  for (const t of tabs.values()) t.view.setBounds({ x: 0, y: UI_TOP, width: Math.max(0, w - panelWidth), height: Math.max(0, h - UI_TOP) });
}

function tabInfo(t) {
  const wc = t.view.webContents;
  const url = shownUrl(t);
  return { id: t.id, title: wc.getTitle() || url || "New tab", url, loading: wc.isLoading(), private: t.private,
    // The lock says what the page in front of the person is: "Secure" only for a page that really came over https.
    secure: !t.failed && (url === "" || url.startsWith("https://") || url.startsWith("data:")),
    state: t.failed ? "Could not open" : "",
    canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(),
    agent: Boolean(agent && agent.tab === t.id && !agent.stopped) };
}

function sendTabs() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("tabs", { tabs: [...tabs.values()].map(tabInfo), active: activeId,
    agent: agent ? { tab: agent.tab, stopped: agent.stopped, reason: agent.reason || "" } : null });
}

// --- the agent's hold on a tab --------------------------------------------------------------------------------------
function stopAgent(reason) {
  if (!agent || agent.stopped) return;
  agent.stopped = true;
  agent.reason = reason;
  if (agent.job) helperCall("POST", `/api/jobs/${agent.job}/cancel`).catch(() => {});
  sendTabs();
}

function agentTab(id) {
  if (!agent || agent.stopped) {
    const err = new Error(agent?.reason || "The agent has no tab.");
    err.code = 409;
    throw err;
  }
  const t = tabs.get(Number(id) || agent.tab);
  if (!t || t.id !== agent.tab) {
    const err = new Error("That is not the agent's tab.");
    err.code = 403;
    throw err;
  }
  return t;
}

const agentUrl = (t) => (t.failed ? "" : shownUrl(t));  // what the agent is told: nowhere while "could not open" is up

function waitLoaded(wc, ms = 15000) {
  return new Promise((resolve) => {
    if (!wc.isLoading()) return setTimeout(resolve, 150);
    const done = () => { clearTimeout(timer); wc.removeListener("did-stop-loading", done); setTimeout(resolve, 150); };
    const timer = setTimeout(done, ms);
    wc.once("did-stop-loading", done);
  });
}

async function synthetic(fn) {
  // Our own input events must not read as the person taking over. Chromium may deliver them after sendInputEvent
  // returns, so the window stays open a little after the call, not only during it.
  agent.syntheticUntil = Date.now() + 5000;
  try { return await fn(); } finally { if (agent) agent.syntheticUntil = Date.now() + 600; }
}

const routes = {
  "POST /agent/start": async (b) => {
    if (agent && !agent.stopped) throw Object.assign(new Error("Another task is using a tab."), { code: 409 });
    let id = Number(b.tab) || 0;
    if (id && tabs.get(id)?.private) {  // the panel refuses too: nothing from a private tab is handed to a model
      throw Object.assign(new Error("Tasks do not run in private tabs."), { code: 403 });
    }
    if (!id) id = activeId;
    if (b.new_tab || !tabs.has(id) || tabs.get(id).private) id = newTab(HOME, false).id;  // a private tab in front: a fresh normal one
    agent = { tab: id, policy: { allow: b.policy?.allow || [], deny: b.policy?.deny || [], block_private: Boolean(b.policy?.block_private) },
      stopped: false, reason: "", blocked: [], downloads: [], navs: [], seq: 1, dir: String(b.downloads || path.join(app.getPath("downloads"), "Rooks")),
      job: b.job || pendingJob, syntheticUntil: 0 };
    pendingJob = null;
    activate(id);
    return { tab: id };
  },
  "POST /agent/end": async () => { if (agent) { agent.stopped = true; agent.reason = agent.reason || "Finished."; } sendTabs(); return {}; },
  "GET /agent/state": async () => {
    if (!agent) return { stopped: true, reason: "No task." };
    const t = tabs.get(agent.tab);
    const wc = t?.view.webContents;
    // While our "could not open" page is up the tab is nowhere: url is empty and `failed` says what did not open.
    return { tab: agent.tab, stopped: agent.stopped, reason: agent.reason, url: t ? (t.failed ? "" : shownUrl(t)) : "", title: wc ? wc.getTitle() : "",
      failed: t?.failed ? { url: t.failed.url, why: t.failed.why } : null, status: t?.lastStatus || 0,
      blocked: agent.blocked, downloads: agent.downloads, navs: agent.navs, tabs: tabs.size };
  },
  "POST /tab/eval": async (b) => {
    const t = agentTab(b.tab);
    // A function (called with arg) or a plain expression, like Playwright's page.evaluate
    const src = String(b.fn).trim().replace(/;+\s*$/, "");  // "(() => {...})();" is a valid script, not a valid ( expression )
    const code = `(() => { const f = (${src}); return typeof f === "function" ? f(${JSON.stringify(b.arg ?? null)}) : f; })()`;
    const result = await t.view.webContents.executeJavaScript(code, true);
    return { result: result === undefined ? null : result };  // JSON drops undefined; say null so callers see the key
  },
  "POST /tab/open": async (b) => {
    const t = agentTab(b.tab);
    const n = agent.blocked.length;
    try { await t.view.webContents.loadURL(String(b.url)); } catch (e) {
      if (agent.blocked.length > n) return { url: agentUrl(t), blocked: agent.blocked[agent.blocked.length - 1].why };
      if (!/ERR_ABORTED/.test(String(e))) return { url: agentUrl(t), error: String(e.message || e).split("\n")[0] };
    }
    await waitLoaded(t.view.webContents);
    return { url: agentUrl(t), status: t.lastStatus };
  },
  "POST /tab/back": async (b) => {
    const t = agentTab(b.tab);
    if (t.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack();
    await waitLoaded(t.view.webContents);
    return { url: agentUrl(t) };
  },
  "POST /tab/wait": async (b) => {
    const t = agentTab(b.tab);
    await waitLoaded(t.view.webContents, Math.min(Number(b.ms) || 8000, 30000));
    return { url: agentUrl(t) };
  },
  "POST /tab/screenshot": async (b) => {
    const t = agentTab(b.tab);
    const img = await t.view.webContents.capturePage();
    return { data: (b.jpeg ? img.toJPEG(60) : img.toPNG()).toString("base64") };
  },
  "POST /tab/click": async (b) => {
    const t = agentTab(b.tab);
    const wc = t.view.webContents;
    const x = Math.round(Number(b.x)), y = Math.round(Number(b.y));
    await synthetic(async () => {
      wc.sendInputEvent({ type: "mouseMove", x, y });
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    });
    await new Promise((r) => setTimeout(r, 120));
    await waitLoaded(wc);
    return { url: agentUrl(t) };
  },
  "POST /tab/insert": async (b) => {
    const t = agentTab(b.tab);
    await synthetic(() => t.view.webContents.insertText(String(b.text ?? "")));
    return {};
  },
  "POST /tab/key": async (b) => {
    const t = agentTab(b.tab);
    const wc = t.view.webContents;
    const key = String(b.key || "Enter");
    await synthetic(async () => {
      wc.sendInputEvent({ type: "keyDown", keyCode: key });
      if (key === "Enter") wc.sendInputEvent({ type: "char", keyCode: "\r" });
      wc.sendInputEvent({ type: "keyUp", keyCode: key });
    });
    await new Promise((r) => setTimeout(r, 120));
    await waitLoaded(wc);
    return { url: agentUrl(t) };
  },
};

function startControl() {
  const server = http.createServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    // A web page can reach 127.0.0.1 too. Pages always send Origin on these requests; this channel never needs it.
    if (req.headers.origin !== undefined) return reply(403, { detail: "Not for web pages." });
    const auth = String(req.headers.authorization || "");
    const given = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
    const want = Buffer.from(control.token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return reply(401, { detail: "Invalid or missing token." });
    const route = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
    if (!route) return reply(404, { detail: "Not found" });
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
    req.on("end", async () => {
      try { reply(200, await route(raw ? JSON.parse(raw) : {})); } catch (e) { reply(e.code || 500, { detail: String(e.message || e) }); }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { control.port = server.address().port; resolve(); }));
}

// --- the helper that runs tasks (rooks-browser serve) ----------------------------------------------------------------
function freePort() {
  return new Promise((resolve) => {
    const s = require("node:net").createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** The helper's environment: this process's, without the app's secrets and without any key, token or password
 * meant for something else. It gets its own token; the model keys it reads itself (OPENAI_API_KEY and the like)
 * pass through, and with the Rooks app running it uses the app's models through app.json, as the terminal does. */
function helperEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const name = k.toUpperCase();
    if (!MODEL_KEYS.has(name) && (SECRET_ENV.has(name) || SECRET_SUFFIX.test(k))) continue;
    env[k] = v;
  }
  env.ROOKS_BROWSER_TOKEN = helper.token;
  return env;
}

function helperFailed(error, detail) {  // a plain sentence for the panel; the code or signal under "Details"
  if (!helper.error) { helper.error = error; helper.detail = String(detail || ""); }
}

async function startHelper() {
  let cmd = ["rooks-browser"];
  try { if (process.env.ROOKS_BROWSER_CMD) cmd = JSON.parse(process.env.ROOKS_BROWSER_CMD); } catch { /* keep the default */ }
  helper.port = await freePort();
  try {
    helper.proc = spawn(cmd[0], [...cmd.slice(1), "serve", "--port", String(helper.port), "--exit-with-parent"],
      { env: helperEnv(), stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  } catch (e) { helperFailed("The task helper could not be started.", e.code || e.message); return; }
  helper.proc.on("error", (e) => helperFailed(e.code === "ENOENT" ? "The task helper is not installed. Run the Rooks installer."
    : "The task helper could not be started.", e.code || e.message));
  helper.proc.stderr.on("data", (d) => { helper.log = (String(helper.log || "") + d).slice(-4000); });
  helper.proc.on("exit", (code, sig) => { helperFailed("The task helper stopped.", sig ? `signal ${sig}` : `exit code ${code}`); helper.proc = null; });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${helper.port}/healthz`)).ok) return; } catch { /* not up yet */ }
    if (helper.error) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  helperFailed("The task helper did not answer.", "no reply on its port within 10 seconds");
}

class HelperError extends Error {  // a plain message for the panel; the helper's own words under "Details"
  constructor(message, detail) { super(message); this.detail = String(detail || ""); }
}

async function helperCall(method, p, body) {
  if (helper.error && !helper.proc) throw new HelperError(helper.error, helper.detail);
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${helper.port}${p}`, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${helper.token}`, ...(body ? { "Content-Type": "application/json" } : {}) } });
  } catch (e) { throw new HelperError("The task helper did not answer.", e.message || e); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new HelperError("The task helper refused this.", data.detail || `status ${r.status}`);
  return data;
}

/** The side panel gets a plain answer or { problem, detail }: an exception over the bridge would only carry raw text.
 * (Not "error": a job record has an `error` field of its own.) */
async function forPanel(fn) {
  try { return await fn(); } catch (e) { return { problem: String(e.message || e), detail: e instanceof HelperError ? e.detail : "" }; }
}

// --- the UI page's messages (ui/preload.js lists them) ----------------------------------------------------------------
function fromUi(e) {
  return win && e.sender === win.webContents;  // only the browser's own UI page, never a web page
}

function wireUi() {
  const on = (name, fn) => ipcMain.handle(name, (e, ...a) => (fromUi(e) ? fn(...a) : null));
  on("tab:new", (url, isPrivate) => newTab(url || HOME, Boolean(isPrivate)).id);
  on("tab:close", (id) => closeTab(Number(id)));
  on("tab:activate", (id) => activate(Number(id)));
  on("tab:go", (raw) => {
    const t = tabs.get(activeId);
    if (!t) return;
    if (agent && agent.tab === t.id && !agent.stopped) stopAgent("You took over.");
    const url = normalise(raw);
    if (url.startsWith("http://")) insecureOk.add(policy.hostOf(url));  // typed http:// on purpose
    t.view.webContents.loadURL(url).catch(() => {});
  });
  on("tab:back", () => tabs.get(activeId)?.view.webContents.navigationHistory.goBack());
  on("tab:forward", () => tabs.get(activeId)?.view.webContents.navigationHistory.goForward());
  on("tab:reload", () => tabs.get(activeId)?.view.webContents.reload());
  on("ui:panel", (width) => { panelWidth = Math.max(0, Math.min(Number(width) || 0, 720)); layout(); });
  on("ui:ready", () => sendTabs());
  on("task:status", () => ({ ready: Boolean(helper.proc) && !helper.error, error: helper.error, detail: helper.detail }));
  on("task:start", (goal, mode) => forPanel(async () => {
    if (agent && !agent.stopped) throw new Error("A task is already running. Stop it first.");
    const t = tabs.get(activeId);
    if (!t) throw new Error("Open a tab first.");
    if (t.private) throw new Error("Tasks do not run in private tabs, so nothing you do there is handed to a model.");
    const here = t.failed ? null : agentUrl(t) || null;
    const ask = mode === "ask";
    const body = { goal: ask ? `Answer from this page only, without opening other sites: ${goal}` : String(goal),
      start_url: null, max_steps: ask ? 6 : 25, source: "rooks-browser-app",
      allowed_domains: ask && here ? [policy.hostOf(here)] : [],
      electron: { url: `http://127.0.0.1:${control.port}`, token: control.token, tab: t.id } };
    const job = await helperCall("POST", "/api/jobs", body);
    if (agent && agent.tab === t.id && !agent.stopped) agent.job = job.id; else pendingJob = job.id;  // either order
    return job;
  }));
  on("task:get", (id) => forPanel(() => helperCall("GET", `/api/jobs/${encodeURIComponent(id)}`)));
  on("task:answer", (id, approvalId, approve) => forPanel(() =>
    helperCall("POST", `/api/jobs/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`, { approve: Boolean(approve) })));
  on("task:stop", () => stopAgent("You stopped it."));
  on("open:external", (url) => { if (/^https:\/\//.test(String(url))) shell.openExternal(String(url)); });
}

// --- start ----------------------------------------------------------------------------------------------------------
app.on("web-contents-created", (_e, wc) => {
  wc.on("will-attach-webview", (ev) => ev.preventDefault());
});

app.whenReady().then(async () => {
  await startControl();
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 640, minHeight: 480, title: "Rooks Browser", backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "ui", "preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());  // the UI page never leaves itself
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("resize", layout);
  win.on("closed", () => { win = null; });
  wireUi();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "New tab", accelerator: "CmdOrCtrl+T", click: () => newTab() },
      { label: "New private tab", accelerator: "CmdOrCtrl+Shift+N", click: () => newTab(HOME, true) },
      { label: "Close tab", accelerator: "CmdOrCtrl+W", click: () => closeTab(activeId) },
      { type: "separator" }, { role: "quit" }] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { label: "Address bar", accelerator: "CmdOrCtrl+L", click: () => win?.webContents.send("focus", "address") },
      { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => tabs.get(activeId)?.view.webContents.reload() },
      { label: "Stop the task", accelerator: "Escape", click: () => stopAgent("You stopped it.") },
      { role: "togglefullscreen" }] },
  ]));
  await win.loadFile(path.join(__dirname, "ui", "index.html"));
  newTab(process.env.ROOKS_BROWSER_START_URL || HOME);
  await startHelper();
  win?.webContents.send("helper", { ready: !helper.error, error: helper.error, detail: helper.detail });
  if (process.env.ROOKS_BROWSER_CONTROL_FILE) {  // tests read where the channels are; owner only
    fs.writeFileSync(process.env.ROOKS_BROWSER_CONTROL_FILE, JSON.stringify({ url: `http://127.0.0.1:${control.port}`,
      token: control.token, tab: activeId, helper: `http://127.0.0.1:${helper.port}`, helper_token: helper.token,
      helper_error: helper.error }), { mode: 0o600 });
  }
});

app.on("window-all-closed", () => {
  if (helper.proc) helper.proc.kill();
  app.quit();
});
