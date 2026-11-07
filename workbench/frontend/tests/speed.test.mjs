// Speed is the premium feature (docs/design/0003-workroom.md, section 6, principle 4): one poller per kind of data,
// visibility aware, and a request budget per page. The stores are run with a fake clock and a fake network, so the
// counts below are what a minute on that page costs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));

async function load(rel, name) {
  if (!exists(rel)) return null;
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false });
  const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}

const poller = await load("../src/lib/poller.ts", "speed-poller.mjs");
const presence = await load("../src/shell/presence.ts", "speed-presence.mjs");
const room = await load("../src/room/status.ts", "speed-room.mjs");

/** A fake clock: timers fire only when the test moves time on. */
function fakeEnv() {
  let now = 0, seq = 0, hidden = false;
  const timers = new Map();
  const vis = new Set();
  const env = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    hidden: () => hidden,
    onVisibility: (fn) => { vis.add(fn); return () => vis.delete(fn); },
  };
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return {
    env,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
      await flush();
    },
    async setHidden(h) { hidden = h; for (const fn of vis) fn(); await flush(); },
    pending: () => timers.size,
  };
}

test("one poller: many parts showing the data still ask once per tick", async () => {
  assert.ok(poller, "src/lib/poller.ts exists");
  const clock = fakeEnv();
  let asks = 0;
  const p = poller.createPoller({ load: async () => { asks += 1; }, every: (hidden) => (hidden ? null : 5000), env: clock.env });
  const stops = [p.start(), p.start(), p.start()];
  await clock.advance(60000);
  assert.equal(asks, 13, "the first ask plus one every 5 s for a minute, however many parts look");
  for (const s of stops) s();
  await clock.advance(60000);
  assert.equal(asks, 13, "nothing is asked once no part shows the data");
  assert.equal(clock.pending(), 0);
});

test("a hidden tab stops the poller; showing it again asks at once", async () => {
  const clock = fakeEnv();
  let asks = 0;
  const p = poller.createPoller({ load: async () => { asks += 1; }, every: (hidden) => (hidden ? null : 5000), env: clock.env });
  p.start();
  await clock.advance(10000);
  assert.equal(asks, 3);
  await clock.setHidden(true);
  await clock.advance(120000);
  assert.equal(asks, 3, "no ask while hidden");
  await clock.setHidden(false);
  assert.equal(asks, 4, "asked when the tab is shown again");
});

test("an ask in flight is never doubled: a refresh during it becomes one more ask after it", async () => {
  const clock = fakeEnv();
  let asks = 0, release;
  const p = poller.createPoller({ load: () => { asks += 1; return new Promise((r) => { release = r; }); }, every: () => 5000, env: clock.env });
  p.start();
  await clock.advance(0);
  assert.equal(asks, 1);
  void p.refresh(); void p.refresh(); void p.refresh();
  assert.equal(asks, 1, "no second ask while the first is in flight");
  release(); await clock.advance(0);
  assert.equal(asks, 2, "one ask after it, for all three refreshes");
});

function fakeService({ busy = false } = {}) {
  const hits = {};
  const state = { busy, notices: [], last: 7, chats: "1", held: "0" };
  const ask = async (path) => {
    const route = path.split("?")[0];
    hits[route] = (hits[route] || 0) + 1;
    if (route === "/pulse") {
      const after = new URLSearchParams(path.split("?")[1] || "").get("after");
      const notices = after === null ? [] : state.notices.filter((n) => n.id > Number(after));
      return {
        presence: { name: "Rook", mood: state.busy ? "working" : "idle", doing: state.busy ? "Reading your mail" : null, where: state.busy ? "room" : null,
          watching: ["mail", "room"], needs_you: 0, running: { turns: state.busy ? 1 : 0, jobs: 0 } },
        needs_you: 0, notices, notices_after: notices.length ? notices[notices.length - 1].id : after === null ? state.last : Number(after),
        revs: { chats: state.chats, held: state.held },
      };
    }
    throw new Error(`unexpected ${path}`);
  };
  return { ask, hits, state };
}

test("the pulse is the shell's one poll: under 8 a minute on a quiet page, faster while something runs", async () => {
  assert.ok(presence?.createPulseStore, "shell/presence.ts exports createPulseStore");
  const clock = fakeEnv();
  const svc = fakeService();
  const store = presence.createPulseStore(svc.ask, clock.env);
  // the strip, the phone bar, the rail dot, the notifier and the open chat all look at once
  const stops = [store.poller.start(), store.poller.start(), store.poller.start(), store.onNotices(() => undefined), store.onRevs(() => undefined)];
  await clock.advance(60000);
  const quiet = svc.hits["/pulse"];
  assert.ok(quiet <= 8, `quiet: ${quiet} asks a minute (budget 8)`);
  assert.deepEqual(Object.keys(svc.hits), ["/pulse"], "presence, notices and revisions come from the one route");

  svc.state.busy = true;
  await store.poller.refresh();
  svc.hits["/pulse"] = 0;
  await clock.advance(60000);
  assert.ok(svc.hits["/pulse"] >= 12, `busy: ${svc.hits["/pulse"]} asks a minute, so the strip keeps up`);

  await clock.setHidden(true);
  svc.hits["/pulse"] = 0;
  await clock.advance(60000);
  assert.ok(svc.hits["/pulse"] <= 2, `hidden: ${svc.hits["/pulse"]} asks a minute`);
  for (const s of stops) s();
});

test("job notices ride on the pulse: none from before the app opened, each new one once", async () => {
  const clock = fakeEnv();
  const svc = fakeService();
  svc.state.notices = [{ id: 7, job_id: 1, kind: "finished", title: "Old", body: "", at: "" }];
  const store = presence.createPulseStore(svc.ask, clock.env);
  const got = [];
  store.onNotices((list) => got.push(...list.map((n) => n.title)));
  await clock.advance(0);
  assert.deepEqual(got, [], "the first look only learns the cursor");
  svc.state.notices.push({ id: 8, job_id: 2, kind: "needs_you", title: "Needs your OK", body: "", at: "" });
  await clock.advance(10000);
  await clock.advance(10000);
  assert.deepEqual(got, ["Needs your OK"]);
});

test("revisions: a page hears when a chat or a held call changed, not on every tick", async () => {
  const clock = fakeEnv();
  const svc = fakeService();
  const store = presence.createPulseStore(svc.ask, clock.env);
  const moves = [];
  store.onRevs((r, before) => moves.push([before.chats !== r.chats ? "chats" : "", before.held !== r.held ? "held" : ""].filter(Boolean).join("+")));
  await clock.advance(30000);
  assert.deepEqual(moves, [], "nothing changed, nothing heard");
  svc.state.chats = "2";
  await clock.advance(10000);
  svc.state.held = "1";
  await clock.advance(10000);
  assert.deepEqual(moves, ["chats", "held"]);
});

test("the chat page costs under 15 asks a minute while nothing runs", () => {
  // The pulse (above: at most 8) plus the chat's own asks, which no longer run on timers while nothing is held.
  const chat = read("../src/pages/Assistant.tsx");
  assert.doesNotMatch(chat, /setInterval\([^)]*\n?[^)]*\/approvals[\s\S]{0,200}3000\)/, "no 3 s approvals poll");
  assert.match(chat, /if \(!cid \|\| !holding\) return;/, "approvals are asked on a timer only while something is held");
  assert.match(chat, /HELD_POLL_MS = 15000/);
  assert.match(chat, /useRevs\(/, "the thread follows the pulse's revisions for replies from elsewhere");
  assert.doesNotMatch(chat, /}, 8000\);/, "no 8 s conversation poll");
  const list = read("../src/chat/ChatList.tsx");
  assert.match(list, /CHATLIST_POLL_MS = 60000/);
  assert.match(list, /if \(!open\)/, "the chat list asks nothing while the Chats column is closed");
  assert.doesNotMatch(read("../src/v02/JobNotifier.tsx"), /setInterval|\/jobs\/notices/, "the notifier has no poller of its own");
});

test("the Room: one frame a second while stepped in or busy, one every 3 s while watching, none while hidden", () => {
  assert.ok(room?.frameEvery, "room/status.ts exports frameEvery");
  assert.equal(room.frameEvery({ captured: true, busy: false, hidden: false }), 1000);
  assert.equal(room.frameEvery({ captured: false, busy: true, hidden: false }), 1000);
  assert.equal(room.frameEvery({ captured: false, busy: false, hidden: false }), 3000);
  assert.equal(room.frameEvery({ captured: true, busy: true, hidden: true }), null);
  const idle = { where: null, mood: "idle", running: { turns: 0, jobs: 0 } };
  const working = { where: "room", mood: "working", running: { turns: 1, jobs: 0 } };
  assert.equal(room.roomStatusEvery(idle, false), 30000);
  assert.equal(room.roomStatusEvery(working, false), 5000);
  assert.equal(room.roomStatusEvery(idle, true), null);
  // watching an idle Room for a minute: 20 frames, 2 status asks and the pulse (at most 8) is under 30
  const perMin = 60000 / room.frameEvery({ captured: false, busy: false, hidden: false }) + 60000 / room.roomStatusEvery(idle, false) + 60000 / presence.PULSE_IDLE_MS;
  assert.ok(perMin < 30, `idle Room: ${perMin} a minute`);
  const view = read("../src/room/RoomView.tsx");
  assert.match(view, /if \(stop \|\| loading\) return; \/\/ the previous frame has not finished loading/);
  assert.match(view, /frameEvery\(/);
});

// ---------------------------------------------------------------------------------------------- replies start at once
const events = await load("../src/chat/events.ts", "speed-events.mjs");
const scroll = await load("../src/chat/scroll.ts", "speed-scroll.mjs");

test("a reply draws from its first writing event, piece by piece, and is never replayed", () => {
  let s = events.emptyTurn(1);
  s = events.reduceTurn(s, events.parseEvent({ type: "writing", text: "Hel" }));
  assert.equal(s.draft, "Hel", "the first piece is on screen at once");
  s = events.reduceTurn(s, events.parseEvent({ type: "writing", text: "lo th" }));
  s = events.reduceTurn(s, events.parseEvent({ type: "writing", text: "ere." }));
  assert.equal(s.draft, "Hello there.", "each piece is added as it arrives");
  s = events.reduceTurn(s, events.parseEvent({ type: "message", content: "Hello there." }));
  assert.equal(s.reply, "Hello there.");
  assert.equal(s.revealFrom, "Hello there.".length, "the final reply continues the draft: nothing is drawn again");
  assert.match(read("../src/chat/Thread.tsx"), /live\.draft && <div className="msg-text"><Markdown text=\{live\.draft\} \/>/, "the draft is drawn while busy");
  assert.match(read("../src/api.ts"), /reader\.read\(\)[\s\S]*onEvent\(JSON\.parse/, "the stream hands each event over as it is read");
});

test("what you send shows at once, and the thread stays pinned unless you scrolled up", () => {
  const chat = read("../src/pages/Assistant.tsx");
  const run = chat.slice(chat.indexOf("const run = async"), chat.indexOf("await stream(\"/assistant/chat\""));
  assert.match(run, /pinnedRef\.current = true;[\s\S]*if \(opts\.echo\) \{[\s\S]*setMessages\(\(m\) => \[\.\.\.m, \{ id: uid, key: `t\$\{uid\}`, role: "user", content: msg/, "the message joins the thread before the request is sent");
  assert.equal(scroll.isPinned({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 460 }), true, "within a few lines of the bottom");
  assert.equal(scroll.isPinned({ scrollHeight: 2000, scrollTop: 800, clientHeight: 460 }), false, "scrolled up to read");
  assert.equal(scroll.followBehavior(true, false), "auto", "jump while streaming");
  assert.equal(scroll.followBehavior(false, false), "smooth");
  assert.equal(scroll.followBehavior(false, true), "auto", "reduced motion never glides");
  assert.match(chat, /if \(!pinnedRef\.current\) return;/);
});
