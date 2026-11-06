// Chat as a living record (docs/design/0003-workroom.md, package F2): one typed reducer over every chat event, a step
// timeline kept per turn and rebuilt from the server on reload, receipts inline, one reveal, real ids after done,
// undo on result cards, one approval card everywhere, chips in the thread header, a greeting for a new chat, and the
// keyboard shortcuts. The pure parts are run; the rest is read from the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const exists = (p) => existsSync(new URL(p, import.meta.url));
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Bundle one pure TypeScript module for node, or null when it does not exist yet. */
async function load(rel, name) {
  if (!exists(rel)) return null;
  const out = await build({ entryPoints: [fileURLToPath(new URL(rel, import.meta.url))], bundle: true, format: "esm", platform: "node", write: false });
  const dir = fileURLToPath(new URL("../node_modules/.cache/wb-tests/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + name, out.outputFiles[0].text);
  return import(pathToFileURL(dir + name).href);
}

const events = await load("../src/chat/events.ts", "chat-events.mjs");
const turns = await load("../src/chat/turns.ts", "chat-turns.mjs");

// ---------------------------------------------------------------------------------------------- the reducer
test("one typed reducer understands every chat event the service sends", () => {
  assert.ok(events, "src/chat/events.ts exists");
  const types = ["start", "writing", "router", "thought", "tool_call", "tool_result", "card", "watch", "approval_required", "approval_denied",
    "claim_check", "choices", "message", "automate_offer", "stopped", "error", "done", "resumed", "compacted", "tool_delegation"];
  for (const t of types) assert.ok(events.EVENT_TYPES.includes(t), `${t} is in the union`);
  assert.equal(events.parseEvent({ type: "nonsense" }), null, "unknown events are dropped, not crashed on");
  assert.equal(events.parseEvent({ type: "writing", text: 5 }).text, "5", "fields are normalised to their types");
  assert.deepEqual(events.parseEvent({ type: "choices", question: "Which?", options: ["a", 2, ""] }).options, ["a", "2"]);
});

test("a turn keeps its steps, receipts, cards, approvals, draft and reply as the events arrive", () => {
  assert.ok(events, "src/chat/events.ts exists");
  const { emptyTurn, reduceTurn, parseEvent } = events;
  const feed = [
    { type: "start", conversation_id: 7 },
    { type: "router", provider: "demo", model: "demo/x", tier: "fast", fallbacks: [] },
    { type: "thought", content: "I will add the task first." },
    { type: "tool_call", name: "create_task", args: JSON.stringify({ title: "Call Dave" }), from_text: false },
    { type: "tool_result", name: "create_task", ok: true, preview: "{\"id\": 3}", receipt: { verified: true, evidence: "Task #3 exists" } },
    { type: "card", kind: "task", id: 3, title: "Call Dave" },
    { type: "tool_call", name: "send_email", args: JSON.stringify({ to: "dave@example.com", subject: "Hi" }) },
    { type: "tool_result", name: "send_email", ok: false, preview: "Not run yet", receipt: { verified: null, evidence: "" } },
    { type: "approval_required", id: 41, tool: "send_email", args: "{\"to\": \"dave@example.com\"}", effect: "external", reason: "Sending email always needs your approval." },
    { type: "claim_check", backed: false, retrying: true, claim: "I sent it" },
    { type: "tool_delegation", id: 9, tool: "run_command", args: "{}", effect: "command" },
    { type: "writing", text: "Done. " },
    { type: "writing", text: "Added the task." },
    { type: "choices", question: "Next?", options: ["Send it", "Leave it"] },
    { type: "message", content: "Done. Added the task." },
    { type: "automate_offer", key: "k", name: "Morning tasks", request: "add tasks", line: "Want this every morning?" },
    { type: "done", conversation_id: 7, cost_cents: 0.2, tool_calls: 2, outcome: "backed" },
  ];
  let s = emptyTurn(null);
  for (const raw of feed) s = reduceTurn(s, parseEvent(raw));
  assert.equal(s.conversationId, 7);
  assert.equal(s.via.provider, "demo");
  const kinds = s.steps.map((x) => x.kind);
  assert.deepEqual(kinds, ["thought", "call", "call", "check", "delegation"]);
  assert.equal(s.steps[0].text, "I will add the task first.");
  assert.equal(s.steps[1].text, "Adding a task: Call Dave", "plain words from plainStep");
  assert.equal(s.steps[1].state, "ok");
  assert.deepEqual(s.steps[1].receipt, { state: "verified", evidence: "Task #3 exists" });
  assert.equal(s.steps[1].preview, "{\"id\": 3}");
  assert.equal(s.steps[2].state, "held", "a step waiting for an OK is held, not failed");
  assert.equal(s.steps[2].receipt, undefined, "nothing to check means no receipt mark");
  assert.match(s.steps[3].text, /needs a check/i);
  assert.match(s.steps[4].text, /terminal/i, "delegation is a quiet step line");
  assert.equal(s.cards.length, 1);
  assert.equal(s.approvals.length, 1);
  assert.equal(s.approvals[0].id, 41);
  assert.equal(s.draft, "Done. Added the task.");
  assert.equal(s.reply, "Done. Added the task.");
  assert.equal(s.revealFrom, "Done. Added the task.".length, "the streamed text is not replayed");
  assert.deepEqual(s.choices, { question: "Next?", options: ["Send it", "Leave it"] });
  assert.equal(s.offer.name, "Morning tasks");
  assert.equal(s.done.outcome, "backed");
});

test("resumed, compacted, denied, stopped and error read as plain notices and steps", () => {
  assert.ok(events, "src/chat/events.ts exists");
  const { emptyTurn, reduceTurn, parseEvent } = events;
  let s = emptyTurn(3);
  s = reduceTurn(s, parseEvent({ type: "resumed", reason: "restart", at: "2026-11-06T05:40:00+00:00" }));
  s = reduceTurn(s, parseEvent({ type: "compacted", dropped_rows: 12, summary_words: 180 }));
  assert.equal(s.notices[0].text, "Picked up after a restart");
  assert.match(s.notices[1].text, /Earlier parts of this chat were summarised to fit/);
  assert.match(s.notices[1].text, /12/);
  assert.match(s.notices[1].text, /180/);
  s = reduceTurn(s, parseEvent({ type: "tool_call", name: "send_email", args: "{}" }));
  s = reduceTurn(s, parseEvent({ type: "tool_result", name: "send_email", ok: false, preview: "Not run" }));
  s = reduceTurn(s, parseEvent({ type: "approval_denied", id: 5, tool: "send_email", args: "{}", effect: "external", reason: "Nobody was there to say yes." }));
  const denied = s.steps.find((x) => x.name === "send_email");
  assert.equal(denied.state, "failed");
  assert.match(denied.text, /Not done/);
  s = reduceTurn(s, parseEvent({ type: "writing", text: "Half an ans" }));
  s = reduceTurn(s, parseEvent({ type: "stopped", content: "Half an ans" }));
  assert.equal(s.stopped, true);
  s = reduceTurn(s, parseEvent({ type: "error", error: "The model is away." }));
  assert.equal(s.error, "The model is away.");
  assert.equal(s.revealFrom, 0, "no reply arrived, nothing to reveal");
});

// ---------------------------------------------------------------------------------------------- turn helpers
test("a reply the service stamped Not verified becomes a receipt, not a markdown line", () => {
  assert.ok(turns, "src/chat/turns.ts exists");
  const text = "I added it.\n\n**Not verified:** I said \"I added it\", but nothing was changed. Check this before relying on it.";
  const r = turns.splitNotVerified(text);
  assert.equal(r.body, "I added it.");
  assert.match(r.unverified, /nothing was changed/);
  assert.doesNotMatch(r.unverified, /\*\*/);
  assert.deepEqual(turns.splitNotVerified("Plain answer."), { body: "Plain answer.", unverified: undefined });
});

test("on reload every turn's timeline is rebuilt from the conversation's tool rows", () => {
  assert.ok(turns, "src/chat/turns.ts exists");
  const rows = [
    { id: 1, role: "user", content: "Book the plumber", tool_calls: [], name: "" },
    { id: 2, role: "assistant", content: "Let me check.", tool_calls: ["list_tasks", "create_task"], name: "" },
    { id: 3, role: "tool", content: "[]", tool_calls: [], name: "list_tasks", tool_call_id: "a" },
    { id: 4, role: "tool", content: "Error: the tool timed out", tool_calls: [], name: "create_task", tool_call_id: "b" },
    { id: 5, role: "user", content: "You said done but nothing changed", tool_calls: [], name: "claim_check" },
    { id: 6, role: "assistant", content: "I could not add the task.", tool_calls: [], name: "" },
    { id: 7, role: "user", content: "Try again", tool_calls: [], name: "" },
    { id: 8, role: "assistant", content: "Added.", tool_calls: [], name: "" },
  ];
  const out = turns.rebuildTurns(rows);
  assert.equal(out.length, 2, "one turn per user message, claim checks folded in");
  const [a, b] = out;
  assert.equal(a.userId, 1);
  assert.equal(a.replyId, 6);
  assert.deepEqual(a.steps.map((s) => [s.kind, s.state]), [["thought", "ok"], ["call", "ok"], ["call", "failed"], ["check", "failed"]]);
  assert.equal(a.steps[1].text, "Checking tasks");
  assert.equal(a.steps[2].preview, "Error: the tool timed out");
  assert.equal(a.steps[2].receipt, undefined, "a rebuilt step claims no receipt it does not have");
  assert.equal(b.replyId, 8);
  assert.deepEqual(b.steps, []);
});

test("the final reply reveals only what was not streamed, and temporary ids give way to the server's", () => {
  assert.ok(turns, "src/chat/turns.ts exists");
  assert.equal(turns.revealStart("Done. Added", "Done. Added the task."), "Done. Added".length);
  assert.equal(turns.revealStart("", "Done."), 0);
  assert.equal(turns.revealStart("Something else", "Done."), 0);
  assert.equal(turns.revealStart("Done.", "Done."), "Done.".length);
  const local = [
    { id: 10, key: "s10", role: "user", content: "Old", tool_calls: [], name: "" },
    { id: 11, key: "s11", role: "assistant", content: "Older reply", tool_calls: [], name: "" },
    { id: 1762400000001, key: "t1762400000001", role: "user", content: "Book it", tool_calls: [], name: "" },
    { id: 1762400000002, key: "t1762400000002", role: "assistant", content: "Booked.", tool_calls: [], name: "", steps: [{ id: "x" }] },
  ];
  const server = [
    { id: 10, role: "user", content: "Old", tool_calls: [], name: "" },
    { id: 11, role: "assistant", content: "Older reply", tool_calls: [], name: "" },
    { id: 12, role: "user", content: "Book it", tool_calls: [], name: "" },
    { id: 13, role: "assistant", content: "", tool_calls: ["create_event"], name: "" },
    { id: 14, role: "tool", content: "{}", tool_calls: [], name: "create_event" },
    { id: 15, role: "assistant", content: "Booked.", tool_calls: [], name: "" },
  ];
  const adopted = turns.adoptServerIds(local, server);
  assert.deepEqual(adopted.map((m) => m.id), [10, 11, 12, 15]);
  assert.deepEqual(adopted.map((m) => m.key), ["s10", "s11", "t1762400000001", "t1762400000002"], "React keys stay stable so nothing re-mounts");
  assert.deepEqual(adopted[3].steps, [{ id: "x" }], "the live steps stay on the reply");
});

test("a result card finds its history entry so Undo can sit on it", () => {
  assert.ok(turns, "src/chat/turns.ts exists");
  const entries = [
    { id: "h9", at: "2026-11-06T05:41:00", category: "task", tool: "create_task", title: "Added task “Call Dave the plumber about the rough-in”, due 2026-11-10", conversation_id: 4, status: "done", undo: { available: true, confirm: "", reversible: true, note: "" } },
    { id: "h8", at: "2026-11-06T05:40:00", category: "calendar", tool: "create_event", title: "Added “Site meeting at 12 Smith St” to Local", conversation_id: 4, status: "done", undo: { available: true, confirm: "This also removes it from Google.", reversible: true, note: "" } },
    { id: "h7", at: "2026-11-06T05:39:00", category: "task", tool: "create_task", title: "Added task “Call Dave the plumber about the rough-in”", conversation_id: 2, status: "done", undo: { available: true, confirm: "", reversible: true, note: "" } },
    { id: "t5", at: "2026-11-06T05:38:00", category: "chat", tool: "", title: "Answered in chat", conversation_id: 4, status: "done", undo: { available: false, confirm: "", reversible: true, note: "" } },
  ];
  const task = turns.matchHistoryEntry({ kind: "task", title: "Call Dave the plumber about the rough-in" }, entries, 4);
  assert.equal(task.id, "h9", "the newest entry of this chat with that tool and title");
  const event = turns.matchHistoryEntry({ kind: "event", title: "Site meeting at 12 Smith St" }, entries, 4);
  assert.equal(event.id, "h8");
  assert.equal(turns.matchHistoryEntry({ kind: "note", title: "Nope" }, entries, 4), null);
  assert.equal(turns.matchHistoryEntry({ kind: "task", title: "Call Dave the plumber about the rough-in" }, entries, 9), null, "another chat's entry is never offered");
});

test("a new chat greets by the time of day and offers three things to do", () => {
  assert.ok(turns, "src/chat/turns.ts exists");
  assert.equal(turns.greeting(9), "Morning. What should we do first?");
  assert.equal(turns.greeting(14), "Afternoon. What should we do first?");
  assert.equal(turns.greeting(21), "Evening. What should we do first?");
  const routines = [{ kind: "schedule", id: 1, name: "Inbox", sentence: "Every weekday at 8am, summarise my unread email", enabled: true }];
  const chips = turns.suggestionChips(routines);
  assert.equal(chips.length, 3);
  assert.match(chips[0].text, /summarise my unread email/i, "the person's own routines come first");
  assert.ok(chips.every((c) => c.text && c.send), "every chip sends a sentence");
  assert.equal(turns.suggestionChips([]).length, 3, "automation examples fill the rest");
});

// ---------------------------------------------------------------------------------------------- the source
test("the chat page is split: thread, composer, result cards, header, empty state and the three tabs", () => {
  for (const f of ["Thread.tsx", "Composer.tsx", "ResultCards.tsx", "ThreadHeader.tsx", "EmptyChat.tsx", "tabs/MemoryTab.tsx", "tabs/SkillsTab.tsx", "tabs/SettingsTab.tsx"]) {
    assert.ok(exists(`../src/chat/${f}`), `src/chat/${f} exists`);
  }
  const page = read("../src/pages/Assistant.tsx");
  assert.match(page, /export \{ SkillsTab \}/, "the Skills page keeps importing SkillsTab from the chat page");
  assert.match(page, /<Thread/);
  assert.match(page, /<Composer/);
  assert.match(page, /<ThreadHeader/);
  assert.doesNotMatch(page, /function MemoryTab\(/, "the tabs moved out");
  assert.doesNotMatch(page, /className="shoulder"/, "the shoulder column is gone: steps live in the thread");
});

test("the thread draws each turn's timeline with receipts and the one approval card", () => {
  const thread = read("../src/chat/Thread.tsx");
  assert.match(thread, /\bTimeline\b/);
  assert.match(thread, /<Receipt /);
  assert.match(thread, /<ApprovalCard/);
  assert.match(thread, /Picked up after a restart|notices/);
  assert.match(thread, /collapsed|expanded/, "prior turns are collapsed with a count");
  assert.match(thread, /DiffView/);
  assert.doesNotMatch(thread, /role="alertdialog"/, "an inline card is not a modal dialog");
  assert.doesNotMatch(thread, /Approve .*\?/, "copy is Needs your OK, from the primitive");
  const motion = read("../src/motion/index.tsx");
  assert.match(motion, /export function StreamText\(\{ text, onDone, from/, "StreamText can start after the text already shown");
  const live = read("../src/v02/LiveBlocks.tsx");
  assert.match(live, /from/, "LiveMarkdown hands the reveal start down");
});

test("jobs and talk use the same approval card as the chat", () => {
  const jobs = read("../src/v02/Jobs.tsx");
  const talk = read("../src/pages/Talk.tsx");
  for (const [name, src] of [["Jobs", jobs], ["Talk", talk]]) {
    assert.match(src, /import \{[^}]*ApprovalCard[^}]*\} from "\.\.\/ui"/, `${name} imports ApprovalCard`);
    assert.match(src, /<ApprovalCard/, `${name} renders ApprovalCard`);
    assert.doesNotMatch(src, /role="alertdialog"/, `${name} has no raw approval card`);
  }
  assert.doesNotMatch(jobs, /className="job-approval"/);
  assert.doesNotMatch(talk, /Approve \{approval\.tool/);
});

test("result cards carry Undo through the history API with the same confirm handling as History", () => {
  const cards = read("../src/chat/ResultCards.tsx");
  assert.match(cards, /\/history\/\$\{[^}]+\}\/undo/);
  assert.match(cards, /status === 409/);
  assert.match(cards, /confirm/);
  assert.match(cards, />Undo</);
  assert.match(cards, /\/history\?/, "entries come from the history API");
  assert.match(cards, /matchHistoryEntry/);
});

test("the thread header shows the project, the model, effort and Check answers as chips, out of the menu", () => {
  const head = read("../src/chat/ThreadHeader.tsx");
  for (const c of ["<ProjectSwitcher", "<ModelSelect", "<EffortSelect", "<CheckToggle"]) assert.ok(head.includes(c), c);
  assert.match(head, /Hide chats|Show chats/);
  const menu = head.slice(head.indexOf("function ChatMenu"));
  assert.ok(menu.length > 0, "the menu is in the header file");
  assert.doesNotMatch(menu, /<ProjectSwitcher|<CheckToggle/, "the menu no longer hides the switcher and the toggle");
  assert.match(menu, /<Kbd/, "the menu documents the shortcuts");
  assert.match(menu, /New chat/);
  assert.match(menu, /Stop/);
});

test("Esc stops a running turn, Ctrl/Cmd+Shift+O starts a chat, Ctrl/Cmd+/ focuses the composer", () => {
  const page = read("../src/pages/Assistant.tsx");
  assert.match(page, /e\.key === "Escape"[^\n]*stopTurn|stopTurn\(\)[^\n]*Escape/);
  assert.match(page, /shiftKey[^\n]*"o"/);
  assert.match(page, /e\.key === "\/"/);
});

test("a new chat gets a greeting line, three suggestion chips and the Needs you count", () => {
  const empty = read("../src/chat/EmptyChat.tsx");
  assert.match(empty, /greeting\(/);
  assert.match(empty, /suggestionChips/);
  assert.match(empty, /needs_you|needsYou/);
  const css = strip(read("../src/chat/chat.css"));
  assert.match(css, /--font-serif|var\(--serif\)/, "the greeting is the Bodoni line");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, "chat.css has no hex colours");
  assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla)\(/i, "chat.css has no literal colours");
});

test("a step's stored answer reads as plain words, never raw ids or timestamps", () => {
  assert.ok(turns, "src/chat/turns.ts exists");
  const raw = '{"id": 4, "title": "Call Dave the plumber about the rough-in", "notes": "", "status": "todo", "priority": 0, "due": "2026-11-10", "project": "", "created_at": "2026-11-06T06:41:03+00:00", "updated_at": "2026-11-06T06:41:03+00:00", "completed_at": null}';
  const line = turns.plainPreview(raw);
  assert.match(line, /Call Dave the plumber about the rough-in/);
  assert.match(line, /due: 2026-11-10/);
  assert.doesNotMatch(line, /created_at|updated_at|\bid: 4\b|null/);
  assert.equal(turns.plainPreview("Error: the tool timed out"), "Error: the tool timed out");
  assert.equal(turns.plainPreview('{"saved": 1}'), "saved: 1");
  assert.match(turns.plainPreview('[{"id": 1, "title": "A"}, {"id": 2, "title": "B"}]'), /2 items: A, B/);
  const thread = read("../src/chat/Thread.tsx");
  assert.match(thread, /plainPreview\(/, "the step detail uses it");
});

test("a decision answered later closes the held step instead of showing as a message", () => {
  assert.ok(turns, "src/chat/turns.ts exists");
  const rows = [
    { id: 1, role: "user", content: "Email Dave", tool_calls: [], name: "" },
    { id: 2, role: "assistant", content: "", tool_calls: ["send_email"], name: "" },
    { id: 3, role: "tool", content: "Not run yet: send_email is waiting for the user's approval (request #29)", tool_calls: [], name: "send_email" },
    { id: 4, role: "assistant", content: "It needs your OK.", tool_calls: [], name: "" },
    { id: 5, role: "user", content: "[I approved request #29: send_email. Result: Sent to dave@example.com]", tool_calls: [], name: "" },
  ];
  const [t] = turns.rebuildTurns(rows);
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].state, "ok", "approved and run: done");
  assert.match(t.steps[0].preview, /Sent to dave/);
  assert.equal(turns.isDecisionRow(rows[4]), true);
  assert.equal(turns.isDecisionRow(rows[0]), false);
  const denied = turns.rebuildTurns([rows[0], rows[1], rows[2], rows[3], { id: 6, role: "user", content: "[I denied request #29: send_email. Do not do it.]", tool_calls: [], name: "" }]);
  assert.equal(denied.length, 1, "a decision is not a new turn");
  assert.equal(denied[0].steps[0].state, "failed");
  assert.match(denied[0].steps[0].text, /Not done/);
  const thread = read("../src/chat/Thread.tsx");
  assert.match(thread, /isDecisionRow/, "decision rows are not drawn as bubbles");
  // a live turn's receipts survive the reload that follows a decision
  const live = [{ id: "s1", kind: "call", name: "create_task", args: "{\"title\":\"X\"}", text: "Adding a task: X", state: "ok", receipt: { state: "verified", evidence: "task #4 saved" } }];
  const rebuilt = [{ id: "r1", kind: "call", name: "create_task", args: "", text: "Adding a task", state: "ok", preview: "{}" }];
  const merged = turns.mergeSteps(live, rebuilt);
  assert.equal(merged[0].text, "Adding a task: X");
  assert.deepEqual(merged[0].receipt, { state: "verified", evidence: "task #4 saved" });
});

// ---------------------------------------------------------------------------------------------- the Room in the chat
test("a step in the Room is said by what it does there, in plain words", async () => {
  const steps = await load("../src/plainStep.ts", "chat-plainstep.mjs");
  const say = (args) => steps.plainStep("use_room", JSON.stringify(args));
  assert.equal(say({ action: "up", goal: "Try the new build" }), "Starting the Room: Try the new build");
  assert.equal(say({ action: "run", command: "make test" }), "Running in the Room: make test");
  assert.equal(say({ action: "checkpoint", label: "Before the upgrade" }), "Saving a point in the Room: Before the upgrade");
  assert.equal(say({ action: "reset" }), "Starting the Room over");
  assert.equal(say({ action: "reset", name: "cp-3" }), "Starting the Room over from cp-3");
  assert.equal(say({ action: "handoff", src: "/home/rooks/report.pdf", dest: "~/Desktop" }), "Copying a file out of the Room: /home/rooks/report.pdf");
  assert.equal(say({ action: "down" }), "Stopping the Room");
  assert.equal(say({ action: "status" }), "Checking the Room");
  assert.equal(say({}), "Using the Room");
  assert.equal(steps.plainStep("use_room"), "Using the Room");
});

test("a watched Room is drawn from the Room's own screen, and only while the Room says it has one", async () => {
  const watch = await load("../src/chat/watch.ts", "chat-watch.mjs");
  assert.ok(watch, "src/chat/watch.ts exists");
  const room = watch.watchSource({ surface: "room", job_id: "room", goal: "Try the build" });
  assert.equal(room.kicker, "Room");
  assert.equal(room.screenshot, "/api/room/screenshot");
  assert.equal(room.status, "/room/status");
  assert.equal(room.open, "/room");
  const browser = watch.watchSource({ surface: "browser", job_id: "7" });
  assert.equal(browser.screenshot, "/api/browser/jobs/7/screenshot");
  assert.equal(browser.open, "/browser/7");
  assert.equal(browser.status, undefined, "a browser job's frame is served while the job runs");
  const desk = watch.watchSource({ surface: "computer", job_id: "9" });
  assert.equal(desk.screenshot, "/api/desk/jobs/9/screenshot");
  assert.equal(desk.open, "/computer/9");
  // the honesty rule: no screen unless the Room is running and really has one
  assert.equal(watch.roomScreenLive({ running: true, screen: true, label: "A private desktop on this computer" }), true);
  assert.equal(watch.roomScreenLive({ running: true, screen: false, label: "A private folder and shell" }), false);
  assert.equal(watch.roomScreenLive({ running: false, screen: true, label: "" }), false);
  assert.equal(watch.roomScreenLive(null), false);
  assert.match(watch.roomNoScreenLine({ running: true, screen: false, label: "A private folder and shell" }), /A private folder and shell/);
  assert.match(watch.roomNoScreenLine({ running: false, screen: false, label: "" }), /off/i);
  const cards = read("../src/chat/ResultCards.tsx");
  assert.match(cards, /watchSource\(/, "the watch card uses the one mapping");
  assert.doesNotMatch(cards, /<img/, "the card polls no picture: the Stage shows the surface (package F3)");
  assert.match(read("../src/room/RoomView.tsx"), /roomScreenLive\(/, "the Room's stage asks the Room before it polls a picture");
  assert.match(read("../src/stage/surfaces.tsx"), /watchSource\(/, "the job surfaces draw from the one mapping");
  assert.doesNotMatch(cards, /desk\/jobs\/\$\{watch\.job_id\}/, "no hand-written screenshot paths in the card");
});

test("a rebuilt step takes its words and its receipt from the run log when the calls match one for one", async () => {
  const receipts = await load("../src/chat/receipts.ts", "chat-receipts.mjs");
  assert.ok(receipts.applyTrace, "receipts.applyTrace exists");
  const steps = [
    { id: "r1", kind: "thought", name: "", args: "", text: "Let me start it.", state: "ok" },
    { id: "r2", kind: "call", name: "use_room", args: "", text: "Using the Room", state: "ok", preview: "{}" },
    { id: "r3", kind: "call", name: "use_room", args: "", text: "Using the Room", state: "held", preview: "Not run yet: ..." },
  ];
  const found = [
    { id: 11, kind: "tool_call", tool: "use_room", outcome: "done", verified: 1, evidence: "The Room reported running.", args: JSON.stringify({ action: "up", goal: "Try the build" }) },
    { id: 12, kind: "tool_call", tool: "use_room", outcome: "held", verified: null, evidence: "", args: JSON.stringify({ action: "run", command: "make test" }) },
  ];
  const out = receipts.applyTrace(steps, found);
  assert.equal(out[0].text, "Let me start it.");
  assert.equal(out[1].text, "Starting the Room: Try the build");
  assert.deepEqual(out[1].receipt, { state: "verified", evidence: "The Room reported running." });
  assert.equal(out[2].text, "Running in the Room: make test");
  assert.equal(out[2].receipt, undefined);
  assert.equal(out[2].state, "held", "the rows' state stays");
  assert.equal(receipts.applyTrace(steps, found.slice(0, 1)), null, "a run log that does not match one for one is not used");
  const kept = [{ id: "s1", kind: "call", name: "use_room", args: JSON.stringify({ action: "up", goal: "Mine" }), text: "Starting the Room: Mine", state: "ok" }];
  assert.equal(receipts.applyTrace(kept, [found[0]])[0].text, "Starting the Room: Mine", "a step that knows its own words keeps them");
  const denied = [{ id: "s2", kind: "call", name: "send_email", args: "", text: "Not done: Preparing to send mail", state: "failed", preview: "You said no." }];
  assert.equal(receipts.applyTrace(denied, [{ id: 3, kind: "tool_call", tool: "send_email", outcome: "denied", verified: null, evidence: "", args: "{\"to\": \"a@b.c\"}" }])[0].text, "Not done: Preparing to send mail");
});

test("the run log's turns are found whether the service answers with a list or a page", async () => {
  const receipts = await load("../src/chat/receipts.ts", "chat-receipts.mjs");
  assert.ok(receipts.turnsFrom, "receipts.turnsFrom exists");
  const rows = [
    { id: 21, ts: "2026-11-06T11:44:39+00:00", kind: "model_call", conversation_id: 2 },
    { id: 10, ts: "2026-11-06T11:44:37+00:00", kind: "turn", conversation_id: 2 },
    { id: 30, ts: "2026-11-06T11:50:00+00:00", kind: "turn", conversation_id: 2 },
  ];
  assert.deepEqual(receipts.turnsFrom(rows).map((t) => t.id), [10, 30], "a bare list, turns only, oldest first");
  assert.deepEqual(receipts.turnsFrom({ runs: rows }).map((t) => t.id), [10, 30], "a page with a runs field");
  assert.deepEqual(receipts.turnsFrom(null), []);
});

test("asking the run log for a turn's receipts is not cancelled by its own bookkeeping", () => {
  const thread = read("../src/chat/Thread.tsx");
  // the old code kept "asked" in state: setting it re-ran the effect, whose cleanup dropped the answer on arrival
  assert.doesNotMatch(thread, /setAsked\(/, "no state flip inside the effect that fetches receipts");
  assert.match(thread, /askedFor\.current === steps/, "a ref remembers which steps were asked about");
  assert.match(thread, /cur === asked \? withReceipts : cur/, "the answer only lands on the steps it was asked for");
});

test("a yes given later re-runs the held call under it in the run log; that re-run is the same step, not another", async () => {
  const receipts = await load("../src/chat/receipts.ts", "chat-receipts.mjs");
  assert.ok(receipts.traceCalls, "receipts.traceCalls exists");
  const tree = {
    id: 40, kind: "turn", tool: "", outcome: "no_claim", verified: null, evidence: "", children: [
      { id: 42, kind: "model_call", tool: "", outcome: "ok", verified: null, evidence: "", children: [] },
      { id: 43, kind: "tool_call", tool: "use_room", outcome: "held", verified: null, evidence: "", args: "{\"action\": \"up\"}", children: [
        { id: 58, kind: "decision", tool: "use_room", outcome: "approved", verified: null, evidence: "", children: [
          { id: 59, kind: "tool_call", tool: "use_room", outcome: "verified", verified: 1, evidence: "The Room reported running.", args: "{\"action\": \"up\"}", children: [] },
        ] },
      ] },
      { id: 46, kind: "tool_call", tool: "use_room", outcome: "held", verified: null, evidence: "", args: "{\"action\": \"run\", \"command\": \"make test\"}", children: [] },
    ],
  };
  const calls = receipts.traceCalls(tree);
  assert.deepEqual(calls.map((c) => c.id), [43, 46], "the re-run is folded into the held call it answers");
  assert.equal(calls[0].verified, 1, "the re-run's check is the held call's receipt");
  assert.equal(calls[0].evidence, "The Room reported running.");
  assert.equal(calls[0].args, "{\"action\": \"up\"}");
});
