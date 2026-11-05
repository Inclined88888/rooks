import { SquareTerminal, ArrowLeft, ArrowUp, BookOpen, Brain, Check, Copy, Ellipsis, KeyRound, Pencil, Plus, RotateCcw, ShieldAlert, Square, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, stream } from "../api";
import { Tracer } from "../Tracer";
import { EffortSelect, Empty, Markdown, ModelSelect, relTime, RouterInfo, RouterVia, useEffort, useModels, useToast } from "../util";
import { Thinking, useExit } from "../motion";
import { LiveMarkdown } from "../v02/LiveBlocks"; // feat/v02-automations: live docs, sheets and charts in replies
import { DictateButton } from "../voice/DictateButton"; // feat/v02-anywhere-voice (drawn as the motion voice orb)
import { CheckThis, CheckToggle, ProjectSwitcher } from "../v02/ChatExtras"; // feat/v02-core
import { WebSearchSetup } from "./ModelSignIn";
import { askNotifyPermission, inBackground, notify } from "../desktop"; // feat/tauri-native
import { Att, AttachButton, filesFrom, MessageAttachments, PendingChips, useAttachments } from "../Attachments"; // feat/attachments
import { DiffView, extractDiffFromArgs } from "../components/DiffView";
import { plainStep } from "../plainStep";
import { TryRoomButton } from "../TryRoom";

type Conv = { id: number; title: string; channel: string; updated_at: string; model: string };
type Choices = { question: string; options: string[] };
type Card = { kind: string; id?: number; title?: string; to?: string; subject?: string; body?: string; status?: string; start?: string; due?: string; sentence?: string; routine_kind?: string; name?: string; surface?: string; job_id?: string; goal?: string; files?: string[]; note_kind?: string; location?: string };
type Watch = { surface: string; job_id: string; goal?: string };
type Routine = { kind: string; id: number; name: string; sentence: string; enabled: boolean };
type Msg = { id: number; role: string; content: string; tool_calls: string[]; name: string; via?: RouterInfo; attachments?: Att[]; choices?: Choices; cards?: Card[] };

function ResultCards({ cards }: { cards: Card[] }) {
  if (!cards.length) return null;
  return (
    <div className="result-cards">
      {cards.map((c, i) => {
        if (c.kind === "draft") return (
          <div key={i} className="result-card">
            <strong>Draft email</strong>
            <p className="small muted">{c.status}</p>
            {c.to && <div className="small">To {c.to}</div>}
            {c.subject && <div className="small">{c.subject}</div>}
            {c.body && <p className="small">{c.body}</p>}
            <Link to="/mail">Review in Mail</Link>
          </div>
        );
        if (c.kind === "event") return (
          <div key={i} className="result-card">
            <strong>{c.title || "Event"}</strong>
            <p className="small muted">{[c.start, c.location].filter(Boolean).join(" · ")}</p>
            <Link to="/calendar">Open calendar</Link>
          </div>
        );
        if (c.kind === "task") return (
          <div key={i} className="result-card">
            <strong>{c.title || "Task"}</strong>
            {c.due && <p className="small muted">Due {c.due}</p>}
            <Link to="/tasks">Open tasks</Link>
          </div>
        );
        if (c.kind === "note") return (
          <div key={i} className="result-card">
            <strong>{c.title || "Note"}</strong>
            <Link to={c.id ? `/notes/${c.id}` : "/notes"}>Open it</Link>
          </div>
        );
        if (c.kind === "file") return (
          <div key={i} className="result-card">
            <strong>Files</strong>
            <p className="small">{(c.files || []).join(", ")}</p>
          </div>
        );
        if (c.kind === "routine") return (
          <div key={i} className="result-card">
            <strong>{c.name || "Routine"}</strong>
            <p className="small">{c.sentence}</p>
          </div>
        );
        if (c.kind === "watch" && c.job_id) return <WatchCard key={i} watch={{ surface: c.surface || "computer", job_id: c.job_id, goal: c.goal }} />;
        return null;
      })}
    </div>
  );
}

function WatchCard({ watch }: { watch: Watch }) {
  const [tick, setTick] = useState(0);
  const [gone, setGone] = useState(false);
  useEffect(() => { setGone(false); }, [watch.job_id]);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 2000);
    return () => window.clearInterval(t);
  }, [watch.job_id]);
  const src = watch.surface === "browser"
    ? `/api/browser/jobs/${watch.job_id}/screenshot?k=${tick}`
    : `/api/desk/jobs/${watch.job_id}/screenshot?k=${tick}`;
  const open = watch.surface === "browser" ? `/browser/${watch.job_id}` : `/computer/${watch.job_id}`;
  return (
    <div className="result-card watch-card">
      <div className="row">
        <strong className="grow">{watch.surface === "browser" ? "Browser" : "Computer"}</strong>
        <Link className="btn sm" to={open}>Take over</Link>
      </div>
      {watch.goal && <p className="small muted">{watch.goal}</p>}
      {gone
        ? <p className="small muted">The screen isn't available from here. Take over to open it.</p>
        : <img src={src} alt="What it is looking at" onError={() => { if (tick > 1) setGone(true); }} />}
    </div>
  );
}

function ChoiceButtons({ c, onPick }: { c: Choices; onPick: (s: string) => void }) {
  if (c.options.length < 2) return null;
  return (
    <div className="chat-choices" role="group" aria-label={c.question || "Quick replies"}>
      {c.options.map((o) => (
        <button key={o} type="button" className="btn sm" onClick={() => onPick(o)}>{o}</button>
      ))}
    </div>
  );
}
type Step = { kind: "call" | "check"; name: string; text: string; line: string; ok?: boolean };
type Approval = { id: number; tool: string; args: string; effect: string; reason: string };
type Memory = { id: number; content: string; kind: string; source: string; updated_at: string };
type Skill = { id: number; name: string; description: string; steps: string; uses: number; source: string; enabled: number };

function Chat() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [freshId, setFreshId] = useState<number | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [lookAt, setLookAt] = useState<number | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const location = useLocation();
  const [text, setText] = useState(((location.state as { draft?: string; start?: boolean } | null)?.start ? "" : (location.state as { draft?: string } | null)?.draft) ?? ""); // pre-filled from Files / Sites; Home sends straight away
  // feat/v02-anywhere-voice: a draft handed over while Chat is already open (the ask bar's "Do it in Chat")
  useEffect(() => {
    if (!window.location.pathname.startsWith("/assistant")) return;
    const s = location.state as { draft?: string; start?: boolean } | null;
    if (s?.draft && !s.start) setText(s.draft);
  }, [location.state]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");  // the answer as it is being written (cleared when the step ends)
  const [model, setModel] = useState("");
  const [busySince, setBusySince] = useState(0);
  const exit = useExit<number>(200);
  const { models } = useModels();
  const [effort, setEffort] = useEffort();
  const [workMode, setWorkMode] = useState<"chat" | "plan" | "build">(() => {
    const saved = localStorage.getItem("aiw.workMode");
    return saved === "plan" || saved === "build" ? saved : "chat";
  });
  // The last Code depth, so leaving for Chat and coming back restores Plan or Build.
  const codeDepth = useRef<"plan" | "build">(workMode === "build" ? "build" : "plan");
  const chooseMode = (next: "chat" | "plan" | "build") => {
    if (next !== "chat") codeDepth.current = next;
    setWorkMode(next);
    localStorage.setItem("aiw.workMode", next);
  };
  const isPlan = !!models.find((m) => m.ref === model)?.effort;
  const endRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const cid = id ? Number(id) : null;
  // Who answered each reply this session (the smart router's "via" line); kept across the reload after a new chat
  const viaByReply = useRef(new Map<string, RouterInfo>());
  const abortRef = useRef<AbortController | null>(null); // the in-flight turn; only Stop aborts it
  const busyRef = useRef(false);
  const [editing, setEditing] = useState<number | null>(null); // user message being edited inline
  const [editText, setEditText] = useState("");
  const att = useAttachments(); // feat/attachments: files waiting to go with the next message
  const [dropping, setDropping] = useState(false);
  const [offer, setOffer] = useState<{ key: string; name: string; request: string; line: string } | null>(null);
  const [who, setWho] = useState("Atlas");
  const [mainId, setMainId] = useState<number | null>(null);
  const [watch, setWatch] = useState<Watch | null>(null);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [showRoutines, setShowRoutines] = useState(Boolean((location.state as { routines?: boolean } | null)?.routines));
  const [showTry, setShowTry] = useState(false);
  useEffect(() => { api<{ assistant_name: string }>("/assistant/settings").then((r) => setWho(r.assistant_name || "Atlas")).catch(() => undefined); }, []);
  useEffect(() => { api<{ id: number }>("/assistant/main").then((r) => setMainId(r.id)).catch(() => undefined); }, []);
  const fresh = Boolean((location.state as { fresh?: boolean } | null)?.fresh);
  const listing = Boolean((location.state as { list?: boolean } | null)?.list);
  useEffect(() => {
    if (cid || fresh || listing || busyRef.current) return;
    let stop = false;
    api<{ id: number }>("/assistant/main").then((r) => {
      if (!stop && window.location.pathname === "/assistant") navigate(`/assistant/${r.id}`, { replace: true });
    }).catch(() => undefined);
    return () => { stop = true; };
  }, [cid, fresh, listing, location.pathname]);

  const loadConvs = () => api<Conv[]>("/conversations").then(setConvs).catch(toast.err);
  useEffect(() => { loadConvs(); }, []);
  const loadConv = (id: number) => {
    api<{ messages: Msg[]; model: string }>(`/conversations/${id}`).then((c) => {
      setMessages(c.messages.map((m) => (m.role === "assistant" && viaByReply.current.has(m.content) ? { ...m, via: viaByReply.current.get(m.content) } : m)));
      setModel(c.model || "");
    }).catch(toast.err);
    api<Approval[]>(`/approvals?conversation_id=${id}`).then(setApprovals).catch(toast.err);
  };
  // Approvals raised elsewhere (the rooks terminal on this conversation) show up while the chat is open
  useEffect(() => {
    if (!cid) return;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      api<Approval[]>(`/approvals?conversation_id=${cid}`).then((fresh) => setApprovals((cur) => {
        const ids = new Set(fresh.map((a) => a.id));
        const same = cur.length === fresh.length && cur.every((a) => ids.has(a.id));
        return same ? cur : fresh;
      })).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [cid]);
  useEffect(() => {
    // Opening the chat list while a reply is still being written must not wipe it.
    if (!cid && busyRef.current) return;
    setSteps([]);
    setLookAt(null);
    setApprovals([]);
    setEditing(null);
    if (!cid) return setMessages([]);
    loadConv(cid);
  }, [cid]);

  const decide = async (a: Approval, approve: boolean) => {
    try {
      const r = await api<{ status: string; result: string }>(`/approvals/${a.id}`, { method: "POST", body: { approve } });
      exit.run(a.id, () => setApprovals((xs) => xs.filter((x) => x.id !== a.id)));
      if (r.status === "failed") toast.err(r.result);
      if (cid) loadConv(cid);
    } catch (e) { toast.err(e); }
  };
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, steps]);

  /** One streamed turn. echo: show the user's text as a fresh bubble (not on resend, where it's already on screen
   *  and stored). resend: the server skips saving the user message again. */
  const run = async (msg: string, opts: { echo?: boolean; resend?: boolean; files?: Att[] } = {}) => {
    busyRef.current = true;
    setBusy(true);
    setBusySince(Date.now());
    setSteps([]);
    setLookAt(null);
    setEditing(null);
    if (opts.echo) setMessages((m) => [...m, { id: Date.now(), role: "user", content: msg, tool_calls: [], name: "", attachments: opts.files }]);
    let newId = cid;
    let via: RouterInfo | undefined;
    let stopped = false;
    let lastReply = "";
    let pendingChoices: Choices | null = null;
    const pendingCards: Card[] = [];
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await stream("/assistant/chat", { message: msg, conversation_id: cid, model: model || null, effort: isPlan ? effort : "", mode: workMode, resend: !!opts.resend, attachments: (opts.files ?? []).map((a) => a.id) }, (ev) => {
        const t = ev.type as string | undefined;
        if (t === "writing") { setDraft((d) => d + String(ev.text)); return; }
        if (t !== "router") setDraft("");
        if (t === "start") newId = Number(ev.conversation_id);
        if (t === "router") via = ev as unknown as RouterInfo;
        if (t === "tool_call") setSteps((s) => [...s, { kind: "call", name: String(ev.name), text: String(ev.args), line: plainStep(String(ev.name), String(ev.args)) }]);
        if (t === "tool_result") {
          setSteps((s) => {
            const name = String(ev.name);
            let idx = -1;
            for (let i = s.length - 1; i >= 0; i--) if (s[i].kind === "call" && s[i].name === name && s[i].ok == null) { idx = i; break; }
            if (idx < 0) return s;
            const next = s.slice();
            next[idx] = { ...next[idx], ok: Boolean(ev.ok) };
            return next;
          });
        }
        if (t === "claim_check") setSteps((s) => [...s, { kind: "check", name: "", text: "", ok: false,
          line: ev.retrying ? "That claim needs a check. Asking again." : "That claim is still unchecked." }]);
        if (t === "approval_required") {
          setApprovals((a) => [...a, { id: Number(ev.id), tool: String(ev.tool), args: String(ev.args), effect: String(ev.effect), reason: String(ev.reason) }]);
          if (inBackground()) void notify("Approval needed", `${String(ev.tool)}: ${String(ev.reason || "waiting for your OK")}`, { tag: "approval" });
        }
        if (t === "choices") {
          const options = Array.isArray(ev.options) ? (ev.options as unknown[]).map(String).filter(Boolean) : [];
          if (options.length >= 2) pendingChoices = { question: String(ev.question ?? ""), options };
          return;
        }
        if (t === "card") {
          const card = ev as unknown as Card;
          pendingCards.push(card);
          if (card.kind === "watch" && card.job_id) setWatch({ surface: card.surface || "computer", job_id: card.job_id, goal: card.goal || "" });
          return;
        }
        if (t === "watch") {
          setWatch({ surface: String(ev.surface || "computer"), job_id: String(ev.job_id || ""), goal: String(ev.goal || "") });
          return;
        }
        if (t === "message") {
          lastReply = String(ev.content);
          const mid = Date.now() + 1;
          const choices = pendingChoices ?? undefined;
          const cards = pendingCards.length ? pendingCards.splice(0) : undefined;
          pendingChoices = null;
          if (via) viaByReply.current.set(String(ev.content), via);
          setFreshId(mid);
          setMessages((m) => [...m, { id: mid, role: "assistant", content: String(ev.content), tool_calls: [], name: "", via, choices, cards }]);
        }
        if (t === "automate_offer") setOffer({ key: String(ev.key), name: String(ev.name), request: String(ev.request), line: String(ev.line) });
        if (t === "stopped") stopped = true;
        if (t === "error" || (!t && ev.error)) toast.err(String(ev.error));
      }, ctrl.signal);
    } catch {
      stopped = stopped || ctrl.signal.aborted; // the abort drops the fetch before the server's "stopped" line arrives
    }
    abortRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setDraft("");
    if (!stopped && lastReply && inBackground()) void notify("Reply ready", lastReply.replace(/\s+/g, " ").slice(0, 160), { tag: "reply" });
    loadConvs();
    const doneCid = newId || cid;
    if (stopped && doneCid) loadConv(doneCid); // pick up what the turn kept before it stopped
    else if (newId && newId !== cid && window.location.pathname.startsWith("/assistant")) navigate(`/assistant/${newId}`, { replace: true });
  };

  const pickChoice = (option: string) => {
    if (busy || att.uploading) return;
    askNotifyPermission();
    void run(option, { echo: true });
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const msg = text.trim();
    const files = att.ready;
    if ((!msg && !files.length) || busy || att.uploading) return;
    askNotifyPermission(); // a key press or click, so the browser shows its prompt (once)
    att.clear();
    setText("");
    if (composerRef.current) composerRef.current.style.height = "auto";
    await run(msg, { echo: true, files });
  };

  // Home hands over a sentence and means it: send once, then drop the handoff so a refresh does not send it again.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!window.location.pathname.startsWith("/assistant")) return;
    const handed = location.state as { draft?: string; start?: boolean } | null;
    const msg = handed?.start ? handed.draft?.trim() : "";
    if (!msg) return;
    const t = window.setTimeout(() => {
      navigate(location.pathname, { replace: true, state: null });
      void runRef.current(msg, { echo: true });
    }, 0);
    return () => clearTimeout(t);
  }, [location.key]);

  /** Stop: abort the fetch here and tell the server to cancel the turn, so tools stop too; partial text is kept. */
  const stopTurn = async () => {
    abortRef.current?.abort();
    try {
      if (cid) await api("/assistant/stop", { body: { conversation_id: cid } });
    } catch { /* the abort already ended our side */ }
  };

  const regenerate = async () => {
    if (busy || !cid) return;
    try {
      const r = await api<{ message: string }>(`/conversations/${cid}/regenerate`, { method: "POST", body: {} });
      setMessages((m) => { const i = m.map((x) => x.role).lastIndexOf("user"); return i >= 0 ? m.slice(0, i) : m; });
      await run(r.message, { resend: true });
    } catch (e) { toast.err(e); if (cid) loadConv(cid); }
  };

  const saveEdit = async (m: Msg) => {
    const content = editText.trim();
    if (!content || busy || !cid) return;
    try {
      await api(`/conversations/${cid}/messages/${m.id}`, { method: "PATCH", body: { content } });
      setMessages((ms) => {
        const i = ms.findIndex((x) => x.id === m.id);
        return i < 0 ? ms : [...ms.slice(0, i), { ...ms[i], content }];
      });
      await run(content, { resend: true });
    } catch (e) { toast.err(e); if (cid) loadConv(cid); }
  };

  const visible = messages.filter((m) => (m.role === "user" && m.name !== "claim_check") || (m.role === "assistant" && m.content));
  useEffect(() => {
    if (!showRoutines) return;
    api<{ routines: Routine[] }>("/assistant/routines").then((r) => setRoutines(r.routines)).catch(toast.err);
  }, [showRoutines]);
  useEffect(() => {
    if (!cid) return;
    const t = window.setInterval(() => {
      if (busyRef.current || document.visibilityState !== "visible") return;
      api<{ messages: Msg[] }>(`/conversations/${cid}`).then((c) => {
        setMessages((cur) => {
          const known = new Set(cur.map((m) => m.id));
          const said = new Set(cur.filter((m) => m.role === "assistant").map((m) => m.content));
          const extra = c.messages.filter((m) => m.role === "assistant" && !known.has(m.id) && !said.has(m.content));
          return extra.length ? [...cur, ...extra] : cur;
        });
      }).catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(t);
  }, [cid]);
  const lastReply = [...visible].reverse().find((m) => m.role === "assistant" && m.content);
  const look = lookAt == null || lookAt >= steps.length ? steps.length - 1 : lookAt;
  const shown = look >= 0 ? steps[look] : null;
  const shownDiff = shown?.kind === "call" && (shown.name === "edit_file" || shown.name === "write_file") ? extractDiffFromArgs(shown.text) : null;
  // Screen reader only utility
  const srOnly: React.CSSProperties = {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: 0,
    margin: "-1px",
    overflow: "hidden",
    clip: "rect(0, 0, 0, 0)",
    whiteSpace: "nowrap",
    border: 0
  };

  return (
    <div className="agents-chat">
      <div className="agents-chat-main chat-main">
        <div className="toolbar chat-top agents-thread-top" style={{ position: "relative" }}>
          <div className="toolbar-title truncate">{cid === mainId ? who : (convs?.find((c) => c.id === cid)?.title ?? "New agent")}</div>
          <span className="agents-local-pill" title="Work stays on this computer">On this computer</span>
          <div className="spacer" />
          <div className="tabs mode-tabs agents-mode-head" role="group" aria-label="Mode" title="Chat is for the day. Code is for changing a project, and it asks before it changes files.">
            <button type="button" className={`tab ${workMode === "chat" ? "active" : ""}`} onClick={() => chooseMode("chat")}>Chat</button>
            <button type="button" className={`tab ${workMode !== "chat" ? "active" : ""}`} onClick={() => { if (workMode === "chat") chooseMode(codeDepth.current); }}>Code</button>
          </div>
          {workMode !== "chat" && (
            <div className="tabs mode-tabs agents-mode-head" role="group" aria-label="Code">
              <button type="button" className={`tab ${workMode === "plan" ? "active" : ""}`} onClick={() => chooseMode("plan")}>Plan</button>
              <button type="button" className={`tab ${workMode === "build" ? "active" : ""}`} onClick={() => chooseMode("build")}>Build</button>
            </div>
          )}
          <span className="sr-only">Chat is for the day. Code is for changing a project, and it asks before it changes files.</span>
          <ChatMenu
            showRoutines={showRoutines}
            onRoutines={() => { setShowRoutines((v) => !v); setShowTry(false); setRoutines(null); }}
            onTry={() => { setShowTry((v) => !v); setShowRoutines(false); }}
            cid={cid}
            onTerminal={() => api<{ command: string; expires_in: number }>("/assistant/handoff", { body: { conversation_id: cid } })
              .then((h) => { navigator.clipboard?.writeText(h.command); toast.ok(`Copied: ${h.command}`); })
              .catch(toast.err)}
          />
        </div>
        {showTry && <div className="routines-panel chat-flyout"><TryRoomButton startOpen onClose={() => setShowTry(false)} /></div>}
        {showRoutines && (
          <div className="routines-panel" aria-label="Routines">
            <div className="row"><strong className="grow">Routines</strong><span className="small muted">Pause any time. Sending still asks you.</span></div>
            {routines === null && <p className="small muted">Loading…</p>}
            {routines?.length === 0 && <p className="small muted">None yet. Say “every weekday morning, summarise my inbox”.</p>}
            <ul>
              {routines?.map((r) => (
                <li key={`${r.kind}-${r.id}`}>
                  <span className="grow small">{r.sentence}</span>
                  <button type="button" className="btn sm" onClick={async () => {
                    const next = await api<Routine>("/assistant/routines/pause", { body: { kind: r.kind, id: r.id, enabled: !r.enabled } });
                    setRoutines((list) => (list || []).map((item) => (item.kind === r.kind && item.id === r.id ? { ...item, enabled: next.enabled } : item)));
                  }}>{r.enabled ? "Pause" : "Resume"}</button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {approvals.length > 0 && (
          <div className="approvals-header" role="region" aria-label="Pending approvals" aria-live="polite">
            <div className="approvals-header-inner">
              <div className="approvals-header-title">
                <ShieldAlert size={16} style={{ color: "var(--warn-text)" }} />
                <span><strong>{approvals.length}</strong> pending approval{approvals.length > 1 ? "s" : ""}</span>
              </div>
              <div className="approvals-header-list">
                {approvals.slice(0, 3).map((a) => (
                  <div key={a.id} className="approval-header-item">
                    <span className="tool-name">{plainStep(a.tool, a.args)}</span>
                    <span className="tool-reason">{a.reason}</span>
                  </div>
                ))}
                {approvals.length > 3 && (
                  <div className="approval-header-more">+{approvals.length - 3} more</div>
                )}
              </div>
            </div>
          </div>
        )}
        <div className="chat-stage">
        <div className="chat-scroll" aria-live="polite">
          <main className="chat-thread" role="main" aria-label="Chat conversation">
            <h1 style={srOnly}>Chat conversation</h1>
            {!busy && visible.length === 0 && (
              <div className="chat-hero agents-empty-hero">
                <p className="chat-hero-sub">Ask anything. Work stays on this computer.</p>
              </div>
            )}
            {visible.map((m) => m.role === "user"
              ? <div key={m.id} className="msg user">
                  {editing === m.id ? (
                    <div className="col" style={{ gap: 6, alignItems: "flex-end" }}>
                      <textarea className="input" rows={3} value={editText} aria-label="Edit message" autoFocus
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(m); } if (e.key === "Escape") setEditing(null); }} />
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn sm primary" disabled={busy || !editText.trim()} onClick={() => saveEdit(m)}>Send</button>
                        <button className="btn sm ghost" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="msg-user-row">
                      <div className="col" style={{ gap: 0, alignItems: "flex-end" }}>
                        <MessageAttachments items={m.attachments} />
                        {m.content && <div className="bubble-user">{m.content}</div>}
                      </div>
                      <button className="btn ghost sm icon msg-edit" aria-label="Edit and resend" title="Edit and resend" disabled={busy}
                        onClick={() => { setEditing(m.id); setEditText(m.content); }}><Pencil size={12} /></button>
                    </div>
                  )}
                </div>
              : <div key={m.id} className="msg">
                  <div className="msg-body">
                    <div className="msg-byline" aria-hidden="true">{who}</div>
                    {m.content && (m.id === freshId
                      ? <LiveMarkdown text={m.content} messageId={m.id} streaming onDone={() => setFreshId(null)} />
                      : <LiveMarkdown text={m.content} messageId={m.id} />)}
                    {m.via && <RouterVia r={m.via} />}
                    {m.cards && <ResultCards cards={m.cards.filter((c) => c.kind !== "watch")} />}
                    {m.choices && lastReply?.id === m.id && !busy && <ChoiceButtons c={m.choices} onPick={pickChoice} />}
                    {m.content && m.id !== freshId && (
                      <div className="msg-actions">
                        <MessageFeedback msg={m} />
                        <CheckThis cid={cid} content={m.content} fresh={m.id > 1e12} />
                        {lastReply?.id === m.id && !busy && (
                          <button className="btn ghost sm icon" aria-label="Regenerate reply" title="Answer again" onClick={regenerate}><RotateCcw size={13} /></button>
                        )}
                      </div>
                    )}
                  </div>
                </div>)}
            {approvals.map((a) => {
              const diff = (a.tool === "edit_file" || a.tool === "write_file")
                ? extractDiffFromArgs(a.args)
                : null;
              return (
                <div key={a.id} className={`card col approval-card spring-in${exit.leaving(a.id) ? " leaving-out" : ""}`} style={{ gap: 10 }} role="alertdialog" aria-label={plainStep(a.tool, a.args)}>
                  <div className="row"><ShieldAlert size={16} style={{ color: "var(--warn-text)" }} /> <b>{plainStep(a.tool, a.args)}</b></div>
                  <div className="small muted">{a.reason} {{
                    persistent: "This would change how the assistant behaves from now on.",
                    write: "This changes a file on your computer.",
                    command: "This runs a command on your computer.",
                  }[a.effect] ?? "This acts outside the workspace."}</div>
                  {a.effect === "command" && !diff && <pre className="small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{(() => { try { return String(JSON.parse(a.args).command ?? ""); } catch { return ""; } })()}</pre>}
                  {diff && <DiffView diff={diff} compact />}
                  <div className="row">
                    <button className="btn primary sm" onClick={() => decide(a, true)}>Approve</button>
                    <button className="btn sm" onClick={() => decide(a, false)}>Deny</button>
                  </div>
                </div>
              );
            })}
            {busy && (
              <div className="msg msg-thinking" aria-label="Assistant is working">
                <div className="msg-body">
                  <div className="msg-byline is-thinking" aria-hidden="true">{who}</div>
                  {draft && <div className="msg-text"><Markdown text={draft} /></div>}
                  <Thinking since={busySince} line={steps.at(-1)?.line} />
                </div>
              </div>
            )}
            <div ref={endRef} />
          </main>
        </div>
        {steps.length > 0 && shown && (
          <aside className="shoulder" aria-label="What Rooks is doing">
            <h2>Working</h2>
            <p className="shoulder-now">{shown.line}</p>
            {shownDiff && <DiffView diff={shownDiff} compact />}
            <ol>
              {steps.map((s, i) => (
                <li key={i}>
                  <button type="button" className={i === look ? "on" : ""} aria-current={i === look ? "step" : undefined} onClick={() => setLookAt(i)}>
                    {s.ok === false ? <X size={12} /> : s.ok ? <Check size={12} /> : <span className="shoulder-dot" />}
                    <span>{s.line}</span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        )}
        </div>
        {watch && (
          <div style={{ margin: "0 12px 8px" }}>
            <WatchCard watch={watch} />
          </div>
        )}
        {offer && (
          <div className="card row" style={{ margin: "0 12px 8px", alignItems: "center", gap: 10 }}>
            <div className="grow">
              <div>{offer.line}</div>
              <div className="small muted truncate">{offer.name}</div>
            </div>
            <button type="button" className="btn primary sm" onClick={async () => {
              try { await api("/automations/from-habit", { body: { request: offer.request, name: offer.name } }); toast.ok("Saved. It asks you before it runs."); setOffer(null); }
              catch (e) { toast.err(e); }
            }}>Save</button>
            <button type="button" className="btn ghost sm" onClick={() => { api("/automations/offer-skip", { body: { key: offer.key } }).catch(() => undefined); setOffer(null); }}>Not now</button>
          </div>
        )}
        <form className="composer-wrap agents-composer-wrap" onSubmit={send}>
          <div className={`composer agents-composer has-tracer${busy ? " is-working" : ""}${dropping ? " drop-target" : ""}`}
            onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
            onDragLeave={() => setDropping(false)}
            onDrop={(e) => { const f = filesFrom(e.dataTransfer); setDropping(false); if (f.length) { e.preventDefault(); att.add(f); } }}>
            <Tracer active={busy} label="Assistant is working" />
            <PendingChips items={att.items} onRemove={att.remove} />
            <textarea ref={composerRef} rows={1} value={text} aria-label="Message"
              onChange={(e) => { setText(e.target.value); const t = e.target; t.style.height = "auto"; t.style.height = `${Math.min(240, t.scrollHeight)}px`; }}
              placeholder={visible.length ? "Send follow-up…" : "Ask anything, or describe a job to do…"}
              onPaste={(e) => { const f = filesFrom(e.clipboardData); if (f.length) { e.preventDefault(); att.add(f); } }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <div className="composer-bar">
              <AttachButton onFiles={att.add} disabled={busy} />
              <ModelSelect value={model} onChange={setModel} models={models} />
              {isPlan && workMode !== "chat" && <EffortSelect value={effort} onChange={setEffort} />}
              <div className="spacer" />
              {/* feat/v02-anywhere-voice + motion: one mic. Local/cloud speech-to-text with browser fallback, drawn as the voice orb */}
              <DictateButton orb disabled={busy} onText={(t) => { setText((v) => (v ? v + " " : "") + t); composerRef.current?.focus(); }} />
              {busy
                ? <button type="button" className="btn send" onClick={stopTurn} aria-label="Stop" title="Stop; what was written so far is kept"><Square size={15} /></button>
                : <button className="btn primary send" disabled={(!text.trim() && !att.ready.length) || att.uploading} aria-label="Send"><ArrowUp size={16} /></button>}
            </div>
          </div>
          <div className="agents-composer-status">
            <span>On this computer</span>
            {workMode !== "chat" && <span>{workMode === "plan" ? "Plan" : "Build"}</span>}
          </div>
        </form>
      </div>
      {toast.node}
    </div>
  );
}

function MemoryTab() {
  const [items, setItems] = useState<Memory[]>([]);
  const [q, setQ] = useState("");
  const [form, setForm] = useState({ content: "", kind: "fact" });
  const toast = useToast();
  const load = () => api<Memory[]>(`/memories${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setItems).catch(toast.err);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [q]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try { await api("/memories", { body: form }); setForm({ content: "", kind: "fact" }); load(); } catch (err) { toast.err(err); }
  };
  const groups: [string, Memory[]][] = [["Who you are", items.filter((m) => m.kind === "profile")], ["Preferences", items.filter((m) => m.kind === "preference")], ["Facts", items.filter((m) => m.kind === "fact")]];
  return (
    <div className="col gap-lg">
      <p className="muted" style={{ margin: 0 }}>Learned automatically from your conversations on every channel. "Who you are" is always in context; the rest is recalled when relevant. Edit or delete anything.</p>
      <form className="card row wrap" onSubmit={add}>
        <input className="input grow" style={{ minWidth: 220 }} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Teach it something, e.g. I prefer short answers" />
        <select className="input" style={{ width: 150 }} aria-label="Kind of memory" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
          <option value="profile">Who I am</option><option value="preference">Preference</option><option value="fact">Fact</option>
        </select>
        <button className="btn primary" disabled={form.content.trim().length < 3}>Add</button>
      </form>
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memories" />
      {items.length === 0 && <Empty icon={<Brain size={24} />} title="Nothing remembered yet" hint="Chat normally; it learns as you go." />}
      {groups.filter(([, l]) => l.length).map(([title, list]) => (
        <div key={title}>
          <h3 style={{ marginBottom: 6 }}>{title}</h3>
          <div className="card flush">
            {list.map((m) => (
              <div key={m.id} className="list-item" style={{ cursor: "default" }}>
                <div className="grow">{m.content}<div className="faint small">{m.source === "auto" ? "learned" : m.source === "user" ? "added by you" : "saved by assistant"} · {relTime(m.updated_at)}</div></div>
                <button className="btn ghost sm icon" onClick={async () => { await api(`/memories/${m.id}`, { method: "DELETE" }); load(); }}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </div>
      ))}
      {toast.node}
    </div>
  );
}

export function SkillsTab() {
  const [items, setItems] = useState<Skill[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState<Skill | null>(null);
  const toast = useToast();
  const load = () => api<Skill[]>("/skills").then((r) => setItems(r.filter((s) => s.source !== "github"))).catch(toast.err);
  useEffect(() => { load(); }, []);
  const save = async () => {
    if (!draft) return;
    try {
      if (draft.id) await api(`/skills/${draft.id}`, { method: "PUT", body: { ...draft, enabled: !!draft.enabled } });
      else await api("/skills", { body: { ...draft, enabled: true } });
      setDraft(null); load();
    } catch (e) { toast.err(e); }
  };
  return (
    <div className="col gap-lg">
      <div className="row"><p className="muted grow" style={{ margin: 0 }}>Procedures written here or learned by the assistant after complex tasks. Edit, disable or add your own.</p>
        <button className="btn" onClick={() => setDraft({ id: 0, name: "", description: "", steps: "", uses: 0, source: "user", enabled: 1 })}><Plus size={14} /> Skill</button></div>
      {draft && (
        <div className="card col">
          <input className="input mono" disabled={!!draft.id} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="short-kebab-name" />
          <input className="input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="When to use it" />
          <textarea className="input mono" rows={8} value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value })} placeholder={"1. ...\n2. ..."} />
          <div className="row"><button className="btn primary" onClick={save}>Save</button><button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button></div>
        </div>
      )}
      {items.length === 0 && !draft && <Empty icon={<BookOpen size={24} />} title="No skills yet" hint="Ask for something multi step, like 'plan my week from my calendar and tasks'." />}
      <div className="card flush">
        {items.map((s) => (
          <div key={s.id} className="col" style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
            <div className="row" style={{ cursor: "pointer" }} onClick={() => setOpen(open === s.id ? null : s.id)}>
              <strong className="mono grow">{s.name}</strong>
              <span className="badge">{s.source === "auto" ? "learned" : s.source}</span>
              <span className="faint small">used {s.uses}×</span>
            </div>
            <div className="muted small">{s.description}</div>
            {open === s.id && (
              <>
                <Markdown text={s.steps} />
                <div className="row">
                  <button className="btn sm" onClick={() => setDraft(s)}>Edit</button>
                  <button className="btn sm" onClick={async () => { await api(`/skills/${s.id}`, { method: "PUT", body: { ...s, enabled: !s.enabled } }); load(); }}>{s.enabled ? "Disable" : "Enable"}</button>
                  <button className="btn ghost sm danger" onClick={async () => { if (confirm(`Delete skill ${s.name}?`)) { await api(`/skills/${s.id}`, { method: "DELETE" }); load(); } }}><Trash2 size={13} /></button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      {toast.node}
    </div>
  );
}

type ASettings = { assistant_name: string; timezone: string; learning_enabled: boolean; search_provider: string; cli_token_set: boolean;
  reach_channel?: string;
  telegram: { configured: boolean; running: boolean; bot: string; error: string; allowed_users: string } };

function SettingsTab() {
  const [s, setS] = useState<ASettings | null>(null);
  const [f, setF] = useState({ assistant_name: "", timezone: "", tg_token: "", tg_users: "" });
  const [token, setToken] = useState("");
  const toast = useToast();
  const load = () => api<ASettings>("/assistant/settings").then((r) => { setS(r); setF((x) => ({ ...x, assistant_name: r.assistant_name, timezone: r.timezone, tg_users: r.telegram.allowed_users })); });
  useEffect(() => { load(); }, []);
  const put = async (body: Record<string, unknown>, msg = "Saved") => {
    try { setS(await api<ASettings>("/assistant/settings", { method: "PUT", body })); toast.ok(msg); } catch (e) { toast.err(e); }
  };
  if (!s) return null;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="col gap-lg">
      <div className="card col">
        <h3>Basics</h3>
        <div className="row wrap">
          <label className="field grow">Assistant name<input className="input" value={f.assistant_name} onChange={(e) => setF({ ...f, assistant_name: e.target.value })} /></label>
          <label className="field grow">Timezone (schedules follow it)<input className="input" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} placeholder={browserTz} /></label>
        </div>
        <div className="row">
          {f.timezone !== browserTz && <button className="btn sm ghost" onClick={() => setF({ ...f, timezone: browserTz })}>Use {browserTz}</button>}
          <div className="spacer" />
          <button className="btn primary" onClick={() => put({ assistant_name: f.assistant_name, timezone: f.timezone })}>Save</button>
        </div>
        <label className="check"><input type="checkbox" checked={s.learning_enabled} onChange={(e) => put({ learning_enabled: e.target.checked })} /> Learn memories and skills automatically (uses extra model calls)</label>
        <label className="field">Also tell me on another app
          <select className="input" aria-label="Also tell me on another app" value={s.reach_channel || "off"} onChange={(e) => put({ reach_channel: e.target.value }, "Saved")}>
            <option value="off">Just in this app</option>
            <option value="telegram">Telegram, once it's connected below</option>
            <option value="slack">Slack (connect it on Channels)</option>
          </select>
        </label>
        <p className="small muted">New routines follow this. Telegram needs the connection below. Slack keeps using the Channels page. Nothing is sent until you say yes.</p>
      </div>
      <div className="card col">
        <h3>Web search</h3>
        <WebSearchSetup />
      </div>
      <div className="card col">
        <div className="row"><h3 className="grow">Telegram</h3>{s.telegram.running ? <span className="badge ok">@{s.telegram.bot} online</span> : s.telegram.configured ? <span className="badge danger">offline</span> : <span className="badge">not set up</span>}</div>
        {s.telegram.error && <div className="alert err">{s.telegram.error}</div>}
        <div className="muted small">1. Message @BotFather in Telegram, send /newbot, paste the token. 2. Message @userinfobot for your user id. Only listed ids get answers; scheduled reports go to the first one.</div>
        <div className="row wrap">
          <input className="input grow" type="password" placeholder={s.telegram.configured ? "Token saved (paste to replace)" : "Bot token"} value={f.tg_token} onChange={(e) => setF({ ...f, tg_token: e.target.value })} />
          <input className="input" style={{ width: 200 }} placeholder="Your user id(s), comma separated" value={f.tg_users} onChange={(e) => setF({ ...f, tg_users: e.target.value })} />
          <button className="btn" onClick={() => put({ ...(f.tg_token ? { telegram_token: f.tg_token } : {}), telegram_allowed_users: f.tg_users }, "Telegram saved; connecting…").then(() => setTimeout(load, 4000))}>Save</button>
          {s.telegram.configured && <button className="btn ghost danger" onClick={() => put({ telegram_token: "" }, "Telegram disconnected")}>Disconnect</button>}
        </div>
      </div>
      <div className="card col">
        <div className="row"><KeyRound size={15} /><h3 className="grow">Terminal access</h3>{s.cli_token_set && <span className="badge ok">token active</span>}</div>
        <div className="muted small">Install the <span className="mono">ws</span> command (cli/ws in the repository, Python 3 only), then run <span className="mono">ws login {window.location.origin}</span> and paste the token.</div>
        <div className="row">
          <button className="btn" onClick={async () => { const r = await api<{ token: string }>("/cli-token", { method: "POST" }); setToken(r.token); load(); }}>{s.cli_token_set ? "Replace token" : "Create token"}</button>
          {token && <><span className="mono small truncate grow">{token}</span><button className="btn sm" onClick={() => { navigator.clipboard.writeText(token); toast.ok("Copied"); }}><Copy size={13} /></button></>}
        </div>
        {token && <div className="alert">Shown once. It replaces any previous token.</div>}
      </div>
      {toast.node}
    </div>
  );
}

function ChatMenu({ showRoutines, onRoutines, onTry, cid, onTerminal }: {
  showRoutines: boolean; onRoutines: () => void; onTry: () => void; cid: number | null; onTerminal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <div className="chat-menu">
      <button type="button" className={`btn ghost sm icon${open ? " on" : ""}`} aria-label="More" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Ellipsis size={16} />
      </button>
      {open && (
        <div className="chat-menu-panel" role="menu">
          <button type="button" role="menuitem" className={showRoutines ? "on" : ""} onClick={() => { onRoutines(); setOpen(false); }}>Routines</button>
          <button type="button" role="menuitem" onClick={() => { onTry(); setOpen(false); }}>Try Room</button>
          <div className="chat-menu-row"><ProjectSwitcher cid={cid} /></div>
          <div className="chat-menu-row"><CheckToggle cid={cid} /></div>
          {cid ? <button type="button" role="menuitem" onClick={() => { onTerminal(); setOpen(false); }}><SquareTerminal size={14} /> Continue in terminal</button> : null}
          <hr />
          <button type="button" role="menuitem" onClick={() => { navigate("/assistant-memory"); setOpen(false); }}>Memory</button>
          <button type="button" role="menuitem" onClick={() => { navigate("/assistant-settings"); setOpen(false); }}>Chat settings</button>
          <button type="button" role="menuitem" onClick={() => { navigate("/settings"); setOpen(false); }}>Settings</button>
        </div>
      )}
    </div>
  );
}

export default function Assistant({ tab }: { tab: "chat" | "memory" | "skills" | "settings" }) {
  const navigate = useNavigate();
  if (tab === "chat") return <Chat />;
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <button type="button" className="btn ghost sm" onClick={() => navigate("/assistant")}><ArrowLeft size={14} /> Chat</button>
        <h1 className="grow">{tab === "memory" ? "Memory" : tab === "skills" ? "Skills" : "Chat settings"}</h1>
      </div>
      {tab === "memory" && <MemoryTab />}
      {tab === "skills" && <SkillsTab />}
      {tab === "settings" && <SettingsTab />}
    </div>
  );
}


/** Thumbs and "Fix this" under each reply: both go to /api/learn/feedback, so the next answer follows the lesson. */
function MessageFeedback({ msg }: { msg: Msg }) {
  const [rating, setRating] = useState(0);
  const [mode, setMode] = useState<"" | "why" | "edit">("");
  const [comment, setComment] = useState("");
  const [edited, setEdited] = useState(msg.content);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const send = async (body: { rating?: number; comment?: string; edited?: string }) => {
    setBusy(true);
    try {
      const r = await api<{ note: string }>("/learn/feedback", {
        body: { target_kind: "message", target_id: String(msg.id), original: body.edited !== undefined ? msg.content : "", ...body },
      });
      setNote(r.note || "Thanks, noted.");
      setMode("");
    } catch (e) { toast.err(e); } finally { setBusy(false); }
  };
  const thumb = (r: number) => {
    setRating(r);
    if (r > 0) send({ rating: 1 }); else setMode("why");
  };
  return (
    <div className="msg-feedback">
      {toast.node}
      <div className="row" style={{ gap: 2 }}>
        <button className={`btn ghost sm icon${rating > 0 ? " on" : ""}`} aria-pressed={rating > 0} aria-label="Good answer" title="Good answer" disabled={busy} onClick={() => thumb(1)}><ThumbsUp size={13} /></button>
        <button className={`btn ghost sm icon${rating < 0 ? " on" : ""}`} aria-pressed={rating < 0} aria-label="Not right" title="Not right" disabled={busy} onClick={() => thumb(-1)}><ThumbsDown size={13} /></button>
        <button className="btn ghost sm icon" title="Fix this" aria-label="Fix this" disabled={busy} onClick={() => setMode(mode === "edit" ? "" : "edit")}><Pencil size={13} /></button>
        {note && <span className="muted small" role="status">{note}</span>}
      </div>
      {mode === "why" && (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <input className="input grow" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What should I do differently? (optional)" aria-label="What should I do differently?" />
          <button className="btn sm primary" disabled={busy} onClick={() => send({ rating: -1, comment })}>Send</button>
        </div>
      )}
      {mode === "edit" && (
        <div className="col" style={{ gap: 6, marginTop: 6 }}>
          <textarea className="input" rows={6} value={edited} onChange={(e) => setEdited(e.target.value)} aria-label="Your version" />
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm primary" disabled={busy || edited.trim() === msg.content.trim()} onClick={() => send({ rating, edited })}>Save my version</button>
            <button className="btn sm ghost" onClick={() => setMode("")}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
