// Where the add-on finds the app. The desktop app picks a new port each time it starts and writes it to app.json
// (desktop/sidecar/workbench_server.py), the same file the `rooks` terminal reads (rooks-code/rooks_code/config.py).
// The add-on takes only the address from it: the key in app.json is the app's bridge key, never the add-on's.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appLinkPath, findAppUrl, resolveUrl, SERVER_URL } from "../out/client.js";

test("app.json is looked for where rooks looks for it", () => {
  assert.equal(appLinkPath({}, "linux", "/home/pat"), "/home/pat/.config/ai-workspace/app.json");
  assert.equal(appLinkPath({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/pat"), "/cfg/ai-workspace/app.json");
  assert.equal(appLinkPath({}, "darwin", "/Users/pat"), "/Users/pat/.config/ai-workspace/app.json");
  assert.equal(appLinkPath({ APPDATA: "C:\\Users\\pat\\AppData\\Roaming" }, "win32", "C:\\Users\\pat"),
    "C:\\Users\\pat\\AppData\\Roaming\\ai-workspace\\app.json");
  assert.equal(appLinkPath({ AI_WORKSPACE_APP_FILE: "/tmp/elsewhere.json" }, "linux", "/home/pat"), "/tmp/elsewhere.json");
});

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(s));
  });
}

function linkFile(dir, body) {
  const p = path.join(dir, "ai-workspace", "app.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

test("the open app's address comes from app.json, and its key is never taken", async () => {
  const s = await server((req, res) => { res.writeHead(req.url === "/healthz" ? 200 : 404); res.end("ok"); });
  const url = `http://127.0.0.1:${s.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rooks-vscode-"));
  linkFile(dir, { url: url + "/", key: "bridge-key-not-for-the-add-on", pid: 1 });
  const found = await findAppUrl({ env: { XDG_CONFIG_HOME: dir }, platform: "linux", home: dir });
  s.close();
  assert.equal(found, url);
  assert.ok(!JSON.stringify(found).includes("bridge-key"));
});

test("a file left behind by an app that is no longer running is ignored", async () => {
  const s = await server((req, res) => res.end("ok"));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rooks-vscode-"));
  linkFile(dir, { url: `http://127.0.0.1:${port}`, key: "k" });
  assert.equal(await findAppUrl({ env: { XDG_CONFIG_HOME: dir }, platform: "linux", home: dir }), "");
});

test("no file, a broken file or an address that is not a web address finds nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rooks-vscode-"));
  const opts = { env: { XDG_CONFIG_HOME: dir }, platform: "linux", home: dir };
  assert.equal(await findAppUrl(opts), "");
  linkFile(dir, "{not json");
  assert.equal(await findAppUrl(opts), "");
  linkFile(dir, { url: "file:///etc/passwd" });
  assert.equal(await findAppUrl(opts), "");
});

test("an address set by hand wins, then the open app, then the server install", () => {
  assert.equal(resolveUrl("https://rooks.example.org/", "http://127.0.0.1:51234"), "https://rooks.example.org");
  assert.equal(resolveUrl("  ", "http://127.0.0.1:51234"), "http://127.0.0.1:51234");
  assert.equal(resolveUrl(undefined, ""), SERVER_URL);
  assert.equal(SERVER_URL, "http://127.0.0.1:3100");
});

test("the address setting is empty by default, so the open app is found", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.contributes.configuration.properties["aiWorkspace.url"].default, "");
});
