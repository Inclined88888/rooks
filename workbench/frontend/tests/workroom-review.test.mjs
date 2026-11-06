// Review fixes on the Workroom branch (docs/design/0003-workroom.md): honest words, chat record correctness,
// accessibility and polling. The pure parts are run; the rest is read from the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

async function load(rel, name) {
  if (!exists(rel)) return null;
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false });
  const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}

const words = await load("../src/room/words.ts", "review-room-words.mjs");
const events = await load("../src/chat/events.ts", "review-chat-events.mjs");
const turns = await load("../src/chat/turns.ts", "review-chat-turns.mjs");
const receipts = await load("../src/chat/receipts.ts", "review-chat-receipts.mjs");
const presence = await load("../src/shell/presence.ts", "review-presence.mjs");

// ---------------------------------------------------------------------------------------------- honest words
test("a private space says only what it keeps apart: the home folder, and no network only when offline", () => {
  assert.equal(words.isolationWords("namespace"), "Your home folder kept apart");
  assert.equal(words.isolationWords("namespace", false), "Your home folder kept apart");
  assert.equal(words.isolationWords("namespace", true), "Your home folder kept apart, no network");
  assert.doesNotMatch(words.isolationWords("namespace"), /network/i, "an online Room never claims the network is kept apart");
  for (const f of ["../src/room/RoomPage.tsx", "../src/room/RoomView.tsx"]) {
    assert.match(read(f), /isolationWords\(status\.isolation, !!status\.offline\)/, `${f} passes whether the Room is offline`);
  }
});

test("the presence strip never says Quiet while a turn is running", () => {
  const { presenceLine } = presence;
  assert.equal(presenceLine({ doing: "", watching: ["mail"], mood: "thinking" }), "Thinking…");
  assert.equal(presenceLine({ doing: "", watching: ["mail"], mood: "working", doing_tool: "mcp__notes__add" }), "Working…");
  assert.equal(presenceLine({ doing: "", watching: ["mail"], mood: "working", doing_tool: "use_room" }), "Using the Room…");
  assert.equal(presenceLine({ doing: "", watching: ["mail"], mood: "working", doing_tool: "search_memory" }), "Looking through what it remembers…");
  assert.equal(presenceLine({ doing: "", watching: ["mail", "calendar"], mood: "idle" }), "Quiet. Watching mail and calendar.");
  assert.equal(presenceLine({ doing: "", watching: ["mail"], mood: "done" }), "Quiet. Watching mail.");
  assert.equal(presenceLine({ doing: "Reading your mail", watching: [], mood: "working" }), "Reading your mail");
});

test("the compaction notice says what is true: shortened, and summarised only when there is a summary", () => {
  const none = events.compactedLine(2, 0);
  assert.doesNotMatch(none, /0 word/);
  assert.doesNotMatch(none, /summar/i, "no summary, so nothing is said to be summarised");
  assert.match(none, /shortened to fit/);
  assert.match(none, /2 earlier messages/);
  const some = events.compactedLine(1, 180);
  assert.match(some, /shortened and summarised to fit/);
  assert.match(some, /1 earlier message\b/);
  assert.doesNotMatch(some, /180/, "the whole summary's size is not what those messages became");
});

test("a duplicate hold reads as already waiting, not as skipped", () => {
  const dup = "Not run: send_email is already waiting for the user's approval (request #5). It was not asked for again. Tell the user you are waiting for their answer, then stop.";
  assert.equal(turns.plainPreview(dup), "Already waiting for your OK.");
  assert.equal(turns.plainPreview("Not run yet: send_email needs the user's OK (request #5)."), "Waiting for your OK.");
  assert.equal(turns.plainPreview("Not run: nobody was there to approve send_email."), "Not run. Nobody was there to say yes, so it was skipped.");
});

test("one product name and one approval phrase", () => {
  assert.doesNotMatch(read("../src/team/types.ts"), /AI Workspace/);
  assert.match(read("../src/team/types.ts"), /app: `\$\{PRODUCT\} app`/);
  const chat = read("../src/pages/Assistant.tsx");
  assert.doesNotMatch(chat, /Approval needed/);
  assert.match(chat, /notify\("Needs your OK"/);
});

// ---------------------------------------------------------------------------------------------- the chat record
const row = (id, role, content, extra = {}) => ({ id, role, content, tool_calls: [], name: "", ...extra });

test("a decision closes the held request itself, not the later 'already waiting' answer", () => {
  const rows = [
    row(1, "user", "Email Dave"),
    row(2, "assistant", "", { tool_calls: ["send_email"] }),
    row(3, "tool", "Not run yet: send_email needs the user's OK (request #5).", { name: "send_email" }),
    row(4, "assistant", "", { tool_calls: ["send_email"] }),
    row(5, "tool", "Not run: send_email is already waiting for the user's approval (request #5). It was not asked for again.", { name: "send_email" }),
    row(6, "assistant", "Waiting for your OK."),
    row(7, "user", "[I approved request #5: send_email. Result: {\"sent\": true}]"),
  ];
  const [t] = turns.rebuildTurns(rows);
  const calls = t.steps.filter((s) => s.kind === "call");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].state, "ok", "the real request is answered");
  assert.match(calls[0].preview, /sent/);
  assert.ok(calls.every((s) => s.state !== "held"), "nothing is left waiting for your OK after the yes");
});

test("request #1 never closes the step held for request #12", () => {
  const rows = [
    row(1, "user", "Send both"),
    row(2, "assistant", "", { tool_calls: ["send_email", "send_email"] }),
    row(3, "tool", "Not run yet: send_email needs the user's OK (request #1).", { name: "send_email" }),
    row(4, "tool", "Not run yet: send_email needs the user's OK (request #12).", { name: "send_email" }),
    row(5, "assistant", "Waiting."),
    row(6, "user", "[I approved request #1: send_email. Result: ok]"),
  ];
  const [t] = turns.rebuildTurns(rows);
  const calls = t.steps.filter((s) => s.kind === "call");
  assert.equal(calls[0].state, "ok", "#1 is answered");
  assert.equal(calls[1].state, "held", "#12 still waits");
});

const entry = (id, at, tool, title, status = "done") => ({ id, at, category: "x", tool, title, conversation_id: 4, status, undo: { available: true, confirm: "", reversible: true, note: "" } });

test("two drafts saved one after the other each keep their own history entry", () => {
  const h1 = entry("h1", "2026-11-06T10:00:01+00:00", "save_email_draft", "Drafted email to dave@example.com: “Rough-in”");
  const h2 = entry("h2", "2026-11-06T10:05:01+00:00", "save_email_draft", "Drafted email to dave@example.com: “Rough-in”", "undone");
  const card = { kind: "draft", to: "dave@example.com", subject: "Rough-in" };
  assert.equal(turns.matchHistoryEntry(card, [h1, h2], 4, "2026-11-06T10:00:03+00:00")?.id, "h1", "the first reply's card takes the entry made before it");
  assert.equal(turns.matchHistoryEntry(card, [h1, h2], 4, "2026-11-06T10:05:03+00:00")?.id, "h2");
  const both = turns.matchHistoryEntries([card, card], [h1, h2], 4);
  assert.deepEqual(both.map((e) => e?.id), ["h1", "h2"], "two cards of one reply never share one entry");
});

test("a short title matches whole words only", () => {
  const things = entry("h3", "2026-11-06T10:00:00+00:00", "create_note", "Created note “Things to do”");
  assert.equal(turns.matchHistoryEntry({ kind: "note", title: "Hi" }, [things], 4), null, "'hi' is not found inside 'things'");
  const hi = entry("h4", "2026-11-06T09:00:00+00:00", "create_note", "Created note “Hi”");
  assert.equal(turns.matchHistoryEntry({ kind: "note", title: "Hi" }, [things, hi], 4)?.id, "h4");
});

test("a timeline asks the run log once, even when the answer adds no receipt", () => {
  assert.ok(receipts.runLogMemory, "receipts.runLogMemory exists");
  const memory = receipts.runLogMemory();
  const steps = [{ id: "r1", kind: "call", name: "get_agenda", args: "", state: "ok", text: "Checking your day" }];
  let asks = 0;
  let cur = steps;
  for (let round = 0; round < 5; round++) {
    if (!memory.wants(cur)) break;
    asks++;
    memory.remember(cur);
    const answer = receipts.applyTrace(cur, [{ id: 1, kind: "tool_call", tool: "get_agenda", outcome: "ok", verified: null, evidence: "" }]);
    assert.notEqual(answer, cur, "the answer is a fresh array");
    memory.remember(answer);
    cur = answer;
  }
  assert.equal(asks, 1);
  assert.equal(memory.wants([...steps]), true, "a new timeline (a reload) may ask again");
  const thread = read("../src/chat/Thread.tsx");
  assert.match(thread, /asked\.current\.remember\(withReceipts\)/, "the answer itself is remembered");
});

// ---------------------------------------------------------------------------------------------- accessibility
test("faint ink is never used for text: labels, ages, placeholders and the .faint utility use muted ink", () => {
  const chat = strip(read("../src/chat/chat.css"));
  for (const sel of [".chatlist-search::placeholder", ".chatlist-label", ".chatlist-empty", ".chatlist-age", ".result-card-kicker"]) {
    const rule = chat.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, sel);
    assert.doesNotMatch(rule[1], /--faint|--color-ink-faint/, `${sel} text is not faint`);
  }
  assert.match(chat, /\.chatlist-head \{[^}]*color: var\(--muted\)/);
  assert.match(chat, /\.chatlist-archived \{[^}]*color: var\(--muted\)/);
  assert.doesNotMatch(chat, /\.chatlist-row\.is-active \.chatlist-age \{[^}]*opacity/);
  const shell = strip(read("../src/shell/shell.css"));
  assert.match(shell, /\.rail-flyout-title \{[^}]*color: var\(--muted\)/);
  assert.match(shell, /\.more-section \{[^}]*color: var\(--muted\)/);
  assert.match(strip(read("../src/ui/ui.css")), /\.ui-input::placeholder \{ color: var\(--color-ink-muted\)/);
  assert.match(strip(read("../src/room/room.css")), /\.room-advanced-list dt \{ color: var\(--color-ink-muted\)/);
  assert.match(strip(read("../src/motion/signature.css")), /\.thinking-time \{[^}]*color: var\(--muted\)/);
  const styles = strip(read("../src/styles.css"));
  assert.match(styles, /\.faint \{ color: var\(--muted\); \}/);
  assert.match(styles, /\.input::placeholder \{ color: var\(--muted\)/);
  assert.match(styles, /\.composer textarea::placeholder \{ color: var\(--muted\)/);
});

/** WCAG contrast of two #RRGGBB colours. */
function contrast(a, b) {
  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

test("the token pairs the design names meet their contrast, and the stated figures are the computed ones", () => {
  const tokens = read("../src/tokens.css");
  const lightEnd = tokens.indexOf('html[data-mode="dark"]');
  const blocks = { light: tokens.slice(0, lightEnd), dark: tokens.slice(lightEnd) };
  const get = (block, name) => {
    const m = blocks[block].match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6});(?:\\s*/\\*\\s*([0-9.]+):1)?`));
    assert.ok(m, `${block} ${name}`);
    return { hex: m[1], stated: m[2] ? Number(m[2]) : null };
  };
  const pairs = [["--color-ink", "--color-bg", 4.5], ["--color-ink-muted", "--color-bg", 4.5], ["--color-ink-muted", "--color-surface", 4.5],
    ["--color-accent-text", "--color-bg", 4.5], ["--color-on-accent", "--color-accent", 4.5], ["--color-border-focus", "--color-bg", 3], ["--color-ink-faint", "--color-bg", 3]];
  for (const block of ["light", "dark"]) {
    for (const [fg, bg, min] of pairs) {
      const f = get(block, fg);
      const ratio = contrast(f.hex, get(block, bg).hex);
      assert.ok(ratio >= min, `${block} ${fg} on ${bg}: ${ratio.toFixed(2)} >= ${min}`);
      if (f.stated !== null && (bg === "--color-bg" || bg === "--color-accent")) {
        assert.ok(Math.abs(f.stated - ratio) < 0.1, `${block} ${fg}: stated ${f.stated}, computed ${ratio.toFixed(2)}`);
      }
    }
  }
});

test("the model and effort chips keep a visible focus ring", () => {
  assert.match(strip(read("../src/chat/chat.css")), /\.chat-chip-select select\.input:focus-visible \{[^}]*outline: 2px solid var\(--color-border-focus\)/);
});

test("the live colour is never the only edge: the Room's focus ring, the stage edge and the dots carry ink", () => {
  const room = strip(read("../src/room/room.css"));
  assert.match(room, /\.room-screen:focus-visible \{[^}]*outline: 2px solid var\(--color-border-focus\)/);
  const ui = strip(read("../src/ui/ui.css"));
  assert.match(ui, /\.ui-timeline-dot\.is-running \{[^}]*box-shadow: 0 0 0 1px var\(--color-ink\)/);
  assert.match(ui, /\.ui-stage\.is-captured \{[^}]*var\(--color-ink\)/);
  assert.match(strip(read("../src/shell/shell.css")), /\.rail-live, \.mobile-live \{[^}]*box-shadow: 0 0 0 1px var\(--color-ink\)/);
});

test("pseudo-elements are never put inside :is() (the browser drops them)", () => {
  for (const f of ["../src/ui/ui.css", "../src/motion/signature.css", "../src/motion.css", "../src/voice/voice.css"]) {
    const css = strip(read(f));
    for (const m of css.matchAll(/:is\(([^)]*)\)/g)) assert.doesNotMatch(m[1], /::/, `${f}: ${m[0]}`);
  }
  assert.match(strip(read("../src/ui/ui.css")), /:root\[data-motion="off"\] \.ui-badge-live::before/);
});

test("the stage's status line stays mounted, names Escape, and says Handed back", async () => {
  const ui = read("../src/ui/index.tsx");
  assert.match(ui, /<p className="ui-stage-captured" role="status">\{capturedLine\(/);
  assert.doesNotMatch(ui, /\{captured && <p className="ui-stage-captured"/);
  const m = ui.match(/export function capturedLine[\s\S]*?\n\}/);
  assert.ok(m);
  const capturedLine = new Function(`${m[0].replace(/export /, "").replace(/: (boolean|string)/g, "")}; return capturedLine;`)();
  assert.match(capturedLine(true, true, "the Room"), /Press Escape or Hand back to stop/);
  assert.equal(capturedLine(false, true, "the Room"), "Handed back.");
  assert.equal(capturedLine(false, false, "the Room"), "");
  const view = read("../src/room/RoomView.tsx");
  assert.match(view, /stepIn\.current\?\.focus\(\)/, "handing back puts focus on Step in");
});

test("the toast region is declared once and stays mounted", () => {
  const ui = read("../src/ui/index.tsx");
  assert.doesNotMatch(ui, /if \(!primary \|\| !items\.length\) return null;/);
  assert.match(ui, /if \(!primary\) return null;/);
});

test("useToast gives every caller one object, so callbacks built on it stay put", () => {
  const ui = read("../src/ui/index.tsx");
  assert.match(ui, /export function useToast\(\) \{\s*return TOAST;\s*\}/);
});

test("Needs you keeps focus and says the outcome after a yes or a no", () => {
  const needs = read("../src/needs/NeedsYou.tsx");
  assert.match(needs, /\.ui-approval-actions button/);
  assert.match(needs, /target\.focus\(\)/);
  assert.match(needs, /<p className="sr-only" role="status">\{said\}<\/p>/);
});

test("each reply's actions are shown on touch screens", () => {
  assert.match(strip(read("../src/chat/chat.css")), /@media \(hover: none\) \{ \.msg-actions, \.msg-feedback, \.msg-edit \{ opacity: 1; \} \}/);
});

test("reduced motion stops the thread's animated scroll", () => {
  assert.match(read("../src/pages/Assistant.tsx"), /scrollIntoView\(\{ behavior: motionOff\(\) \? "auto" : "smooth" \}\)/);
});

test("the working state is announced once: the thread is not a live region and the thinking line is quiet", () => {
  const thread = read("../src/chat/Thread.tsx");
  assert.doesNotMatch(thread, /className="chat-scroll" aria-live/);
  assert.match(thread, /<Thinking [^>]*announce=\{false\}/);
  assert.doesNotMatch(read("../src/chat/Composer.tsx"), /<Tracer [^>]*label=/);
});

test("a receipt sits beside the step's button, never inside it", () => {
  const ui = read("../src/ui/index.tsx");
  const tl = ui.slice(ui.indexOf("export function Timeline"), ui.indexOf("/* ---------------------------------------------------------------- ApprovalCard"));
  const row = tl.slice(tl.indexOf("const row = ("), tl.indexOf("return (", tl.indexOf("const row = (")));
  assert.doesNotMatch(row, /<Receipt/, "the row (the button's content) has no receipt");
  assert.match(tl, /<\/button> : <span className="ui-timeline-row">\{row\}<\/span>\}\s*\{s\.receipt && <Receipt/);
  assert.match(strip(read("../src/ui/ui.css")), /\.ui-receipt:focus \.ui-receipt-evidence/);
});

test("the undo confirm takes focus, is described, and gives focus back", () => {
  const h = read("../src/pages/History.tsx");
  assert.match(h, /aria-describedby="history-confirm-text"/);
  assert.match(h, /yesRef\.current\?\.focus\(\)/);
  assert.match(h, /data-undo-for=\{e\.id\}/);
  assert.match(h, /ev\.key === "Escape"/);
});

test("on a narrow window the Chats column closes again and is not remembered open", () => {
  const list = read("../src/chat/ChatList.tsx");
  assert.match(list, /onOpen=\{\(\) => \{ navigate\(`\/assistant\/\$\{c\.id\}`\); closeFloating\(\); \}\}/);
  assert.match(list, /chatlist-scrim/);
  assert.match(list, /e\.key === "Escape"/);
  assert.match(list, /label="Close chats"/);
  const chat = read("../src/pages/Assistant.tsx");
  assert.match(chat, /if \(matches\(narrowQuery\)\) return false;/);
  assert.match(chat, /if \(!matches\(narrowQuery\)\) \{ try \{ localStorage\.setItem\(CHATLIST_KEY/);
  assert.match(chat, /<ChatList [^>]*floating=\{narrow\}/);
});

// ---------------------------------------------------------------------------------------------- polling
test("the Room's frames are fetched with the sign-in header, not a bare image request", () => {
  const view = read("../src/room/RoomView.tsx");
  assert.match(view, /fetchFrame\(`\/room\/screenshot\?k=/);
  assert.doesNotMatch(view, /`\/api\/room\/screenshot/);
  const api = read("../src/api.ts");
  assert.match(api, /export async function fetchFrame[\s\S]*?authHeaders\(\)/);
});

test("the Room page and the Stage never draw the Room twice", () => {
  const host = read("../src/shell/StageHost.tsx");
  assert.match(host, /useLocation\(\)/);
  assert.match(host, /is open on its page/);
  assert.match(host, /surface === "room" \? "\/room"/);
});

test("the rail's live dot comes from presence, not a second Room status poller", () => {
  assert.ok(presence.roomOn, "presence.roomOn exists");
  assert.equal(presence.roomOn({ watching: ["mail", "room"] }), true);
  assert.equal(presence.roomOn({ watching: ["mail"] }), false);
  for (const f of ["../src/shell/Rail.tsx", "../src/shell/MobileBar.tsx"]) assert.doesNotMatch(read(f), /useRoomStatus/, f);
});
