// The browser's own UI: tabs, address bar, and the Ask Rooks panel. Talks only to window.rooks (ui/preload.js).
"use strict";

const $ = (id) => document.getElementById(id);
const PANEL = 380;  // px; main.js shrinks the page by this much while the panel is open
let state = { tabs: [], active: null, agent: null };
let job = null;
let poll = null;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}

function renderTabs() {
  const box = $("tabs");
  box.replaceChildren(...state.tabs.map((t) => {
    const b = el("div", { class: `tab${t.id === state.active ? " active" : ""}${t.private ? " private" : ""}`, role: "tab",
      "aria-selected": String(t.id === state.active), tabindex: "0", title: t.title, "data-id": String(t.id),
      onclick: () => window.rooks.activate(t.id), onkeydown: (e) => { if (e.key === "Enter") window.rooks.activate(t.id); } },
      t.private ? el("span", { class: "badge" }, "Private") : null,
      t.agent ? el("span", { class: "badge ai-badge" }, "Rooks") : null,
      el("span", { class: "title" }, t.loading ? "Loading…" : t.title),
      el("button", { class: "x", "aria-label": `Close ${t.title}`, onclick: (e) => { e.stopPropagation(); window.rooks.closeTab(t.id); } }, "×"));
    return b;
  }));
  const t = state.tabs.find((x) => x.id === state.active);
  if (t && document.activeElement !== $("url")) $("url").value = t.url;
  $("back").disabled = !t?.canBack;
  $("forward").disabled = !t?.canForward;
  $("lock").textContent = t && t.url ? (t.state || (t.secure ? "Secure" : "Not secure")) : "";  // state: "Could not open"
  $("lock").className = `lock${t && t.url && !t.secure ? " insecure" : ""}`;
  const driving = state.agent && !state.agent.stopped;
  $("driving").hidden = !driving;
  document.body.classList.toggle("is-driving", Boolean(driving));
}

window.rooks.onTabs((d) => { state = d; renderTabs(); });
window.rooks.onFocus((what) => { if (what === "address") { $("url").focus(); $("url").select(); } });
window.rooks.onHelper((h) => showHelper(h));

function showHelper(h) {
  $("helper").textContent = h.ready ? "Ready. I work in the tab you are looking at." : (h.error || "The task helper is not running.");
  $("helper").classList.toggle("warn", !h.ready);
  details("helperdetails", h.ready ? "" : h.detail);
  for (const b of $("task").querySelectorAll("button")) b.disabled = !h.ready;
}

function details(id, text) {  // the technical reason, folded away under "Details"; plain words stay on the page
  $(id).hidden = !text;
  $(id).open = false;
  $(id.replace(/s$/, "")).textContent = text || "";
}

function showProblem(title, message, detail) {
  $("run").hidden = false;
  $("runtitle").textContent = title;
  $("answer").hidden = false;
  $("answer").textContent = message;
  details("answerdetails", detail);
}

$("addr").addEventListener("submit", (e) => { e.preventDefault(); window.rooks.go($("url").value); $("url").blur(); });
$("url").addEventListener("focus", () => $("url").select());
$("newtab").addEventListener("click", () => window.rooks.newTab());
$("newprivate").addEventListener("click", () => window.rooks.newTab("", true));
$("back").addEventListener("click", () => window.rooks.back());
$("forward").addEventListener("click", () => window.rooks.forward());
$("reload").addEventListener("click", () => window.rooks.reload());
$("stop").addEventListener("click", () => window.rooks.stopTask());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.agent && !state.agent.stopped) window.rooks.stopTask(); });

$("toggle").addEventListener("click", () => {
  const open = $("panel").hidden;
  $("panel").hidden = !open;
  $("toggle").setAttribute("aria-expanded", String(open));
  window.rooks.setPanel(open ? PANEL : 0);
  if (open) { $("goal").focus(); window.rooks.taskStatus().then(showHelper); }
});

let mode = "do";
for (const b of $("task").querySelectorAll("button[data-mode]")) b.addEventListener("click", () => { mode = b.dataset.mode; });
$("task").addEventListener("submit", async (e) => {
  e.preventDefault();
  const goal = $("goal").value.trim();
  if (goal.length < 3) return;
  let started;
  try { started = await window.rooks.startTask(goal, mode); } catch { started = { problem: "The task could not be started." }; }
  if (!started || started.problem) return showProblem("Not started", started?.problem || "The task could not be started.", started?.detail);
  job = started;
  $("run").hidden = false;
  $("runtitle").textContent = mode === "ask" ? "Reading this page" : "Working";
  $("steps").replaceChildren();
  $("approvals").replaceChildren();
  $("answer").hidden = true;
  details("answerdetails", "");
  clearInterval(poll);
  poll = setInterval(refresh, 700);
});

async function refresh() {
  if (!job) return;
  let j;
  try { j = await window.rooks.getTask(job.id); } catch { return; }
  if (!j || j.problem) return;  // the helper did not answer this time; the next poll asks again
  $("steps").replaceChildren(...(j.steps || []).map((s) => el("li", { class: s.status === "ok" ? "" : "bad" },
    el("strong", {}, s.next_goal || (s.actions || []).map((a) => a.action || a.name).join(", ") || "Looking"),
    s.result ? el("span", { class: "muted small" }, ` ${s.result}`) : null)));
  $("approvals").replaceChildren(...(j.pending_approvals || []).map((a) => el("div", { class: "approval", role: "group",
    "aria-label": "Needs your OK" },
    el("p", { class: "kicker" }, "Needs your OK"),
    el("p", {}, a.description || a.action),
    el("p", { class: "muted small" }, a.url || ""),
    el("div", { class: "row" },
      el("button", { class: "secondary", onclick: () => window.rooks.answer(j.id, a.id, false).then(refresh) }, "No"),
      el("button", { class: "primary", onclick: () => window.rooks.answer(j.id, a.id, true).then(refresh) }, "Yes, do it")))));
  if (["done", "error", "cancelled"].includes(j.status)) {
    clearInterval(poll);
    $("runtitle").textContent = { done: "Finished", error: "Did not finish", cancelled: "Stopped" }[j.status];
    $("answer").hidden = false;
    // The helper's own error text is technical (what a page or a model said); it goes under "Details", not on the page.
    const final = j.result?.final || (j.status === "error" ? "The task ran into a problem and did not finish."
      : j.status === "cancelled" ? "You stopped the task." : "");
    $("answer").textContent = final ? `${final}\n\nThis is Rooks' own account of what it did; the steps above show the pages it used.` : "";
    details("answerdetails", j.status === "error" ? j.error : "");
  }
}

window.rooks.ready();
window.rooks.taskStatus().then(showHelper);
