/**
 * The Chat page (/assistant, /assistant/:id) and the chat's Memory and Settings tabs (/assistant-memory,
 * /assistant-settings). This file owns the turn: one POST to /api/assistant/chat read as a stream, folded into the
 * turn's record by chat/events.ts, drawn by chat/Thread.tsx. Every turn's steps stay with its reply (rebuilt from
 * the server after a reload), the reply is revealed once, and ids become the server's as soon as the turn is done.
 */
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api, stream, type StreamEvent } from "../api";
import { useEffort, useModels, useToast, type RouterInfo } from "../util";
import { useExit } from "../motion";
import { askNotifyPermission, inBackground, notify } from "../desktop"; // feat/tauri-native
import { useAttachments, type Att } from "../Attachments"; // feat/attachments
import { openBeside } from "../Beside";
import { ChatList } from "../chat/ChatList"; // the Chats column: recent chats, archive, projects
import { matches, narrowQuery, useMediaQuery, wideQuery } from "../shell/breakpoints";
import { openStage, surfaceOf } from "../shell/StageHost";
import { refreshPresence, useRevs } from "../shell/presence";
import { loadCached, peekCached, putCached } from "../lib/cache";
import { emptyTurn, parseEvent, reduceTurn, type Approval, type Offer, type TurnState, type Watch } from "../chat/events";
import { adoptServerIds, mergeSteps, rebuildTurns, stepTitle, type Row } from "../chat/turns";
import { Thread, type Fresh } from "../chat/Thread";
import { followBehavior, isPinned } from "../chat/scroll";
import { isShortcut } from "../lib/shortcuts";
import { chatMode, useDevTools } from "../lib/devTools";
import { Composer } from "../chat/Composer";
import { ThreadHeader } from "../chat/ThreadHeader";
import { EmptyChat } from "../chat/EmptyChat";
import { refreshHistory } from "../chat/ResultCards";
import { forgetRuns } from "../chat/receipts";
import { MemoryTab } from "../chat/tabs/MemoryTab";
import { SettingsTab } from "../chat/tabs/SettingsTab";
import type { Conv, Msg, WorkMode } from "../chat/types";
import { motionOff } from "../appearance";
import "../chat/chat.css";

/** While a call is held in this chat it is also asked this often (else only when the pulse says something moved). */
const HELD_POLL_MS = 15000;

const CHATLIST_KEY = "rooks.chatlist";
/** The Chats column is open by default above the wide breakpoint; the toggle in the thread header is remembered. */
function readChatListOpen(): boolean {
  if (matches(narrowQuery)) return false; // on a phone the column floats over the thread: it never opens by itself
  try {
    const saved = localStorage.getItem(CHATLIST_KEY);
    if (saved === "open") return true;
    if (saved === "closed") return false;
  } catch { /* storage unavailable */ }
  return matches(wideQuery);
}

function mailLine(err: unknown): string {
  const msg = err instanceof Error ? err.message.trim() : "";
  if (!msg || /^\d{3}\b/.test(msg) || /gateway timeout/i.test(msg)) return "Mail did not answer in time.";
  return msg;
}

type Routine = { kind: string; id: number; name: string; sentence: string; enabled: boolean };

/** The server's rows as messages, each turn's steps rebuilt and kept with its reply. */
function fromRows(rows: Row[], via: Map<string, RouterInfo>): Msg[] {
  const byReply = new Map<number, Msg["steps"]>();
  const byUser = new Map<number, Msg["steps"]>();
  for (const t of rebuildTurns(rows)) {
    if (!t.steps.length) continue;
    if (t.replyId !== null) byReply.set(t.replyId, t.steps); else byUser.set(t.userId, t.steps);
  }
  return rows.map((r) => {
    const m = { ...(r as unknown as Msg), key: `s${r.id}`, tool_calls: Array.isArray(r.tool_calls) ? r.tool_calls : [] };
    if (m.role === "assistant" && via.has(m.content)) m.via = via.get(m.content);
    const steps = byReply.get(r.id);
    if (steps) m.steps = steps;
    const orphan = byUser.get(r.id);
    if (orphan) m.orphanSteps = orphan;
    return m;
  });
}

/** Fresh rows from the server, keeping what only this session knows (receipts, notices, the verdict, stable keys).
 *  The rebuilt timeline brings the newer truth (a held step closed by a yes or no); the live one keeps its words. */
function mergeLoaded(cur: Msg[], loaded: Msg[]): Msg[] {
  const known = new Map(cur.map((m) => [m.id, m]));
  return loaded.map((m) => {
    const k = known.get(m.id);
    if (!k) return m;
    const out: Msg = { ...m, key: k.key };
    if (k.role === "assistant") {
      const steps = mergeSteps(k.steps, m.steps);
      if (steps?.length) out.steps = steps;
      if (k.notices?.length) out.notices = k.notices;
      if (k.outcome) out.outcome = k.outcome;
      if (k.via && !out.via) out.via = k.via;
      if (k.cards && !out.cards) out.cards = k.cards;
    }
    return out;
  });
}

function Chat() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const cid = id ? Number(id) : null;
  const cidRef = useRef(cid);
  cidRef.current = cid;
  const [convs, setConvs] = useState<Conv[] | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [live, setLive] = useState<TurnState | null>(null);
  const liveRef = useRef<TurnState | null>(null);
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Chat can sit beside another screen. Follow this screen's own address, and do not
  // send the person back here after they have left it.
  const mounted = useRef(true);
  const pathRef = useRef(location.pathname);
  pathRef.current = location.pathname;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [text, setText] = useState(((location.state as { draft?: string; start?: boolean } | null)?.start ? "" : (location.state as { draft?: string } | null)?.draft) ?? ""); // pre-filled from Files / Sites; Home sends straight away
  // a draft handed over while Chat is already open (the ask bar's "Do it in Chat")
  useEffect(() => {
    if (!location.pathname.startsWith("/assistant")) return;
    const s = location.state as { draft?: string; start?: boolean } | null;
    if (s?.draft && !s.start) setText(s.draft);
  }, [location.state]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [busySince, setBusySince] = useState(0);
  const [model, setModel] = useState("");
  const exit = useExit<number>(120);
  const { models, defaultRef } = useModels();
  const [broken, setBroken] = useState("");
  const [effort, setEffort] = useEffort();
  const [savedMode, setWorkMode] = useState<WorkMode>(() => {
    const saved = localStorage.getItem("aiw.workMode");
    return saved === "plan" || saved === "build" ? saved : "chat";
  });
  // Plan and Build are coding modes: only while "Show developer tools" is on (Settings, Advanced). With it off every
  // chat is a plain chat, and a Build mode saved earlier does not come back until the switch is on again.
  const devTools = useDevTools();
  const workMode = chatMode(savedMode, devTools);
  // The last Code depth, so leaving for Chat and coming back restores Plan or Build.
  const codeDepth = useRef<"plan" | "build">(savedMode === "build" ? "build" : "plan");
  const chooseMode = (next: WorkMode) => {
    if (next !== "chat") codeDepth.current = next;
    setWorkMode(next);
    localStorage.setItem("aiw.workMode", next);
  };
  const isPlan = !!models.find((m) => m.ref === model)?.effort;
  // Who answered each reply this session (the smart router's "via" line); kept across the reload after a new chat
  const viaByReply = useRef(new Map<string, RouterInfo>());
  const abortRef = useRef<AbortController | null>(null); // the in-flight turn; only Stop aborts it
  const [editing, setEditing] = useState<number | null>(null); // user message being edited inline
  const [editText, setEditText] = useState("");
  const att = useAttachments(); // files waiting to go with the next message
  const [offer, setOffer] = useState<Offer | null>(null);
  const [who, setWho] = useState("Atlas");
  const [mainId, setMainId] = useState<number | null>(null);
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [showRoutines, setShowRoutines] = useState(Boolean((location.state as { routines?: boolean } | null)?.routines));
  const [listOpen, setListOpen] = useState<boolean>(readChatListOpen);
  const narrow = useMediaQuery(narrowQuery);
  const toggleList = () => setListOpen((v) => {
    const next = !v;
    // only the wide layout's choice is remembered; the floating column on a narrow window is opened each time
    if (!matches(narrowQuery)) { try { localStorage.setItem(CHATLIST_KEY, next ? "open" : "closed"); } catch { /* storage unavailable */ } }
    return next;
  });
  useEffect(() => { api<{ assistant_name: string }>("/assistant/settings").then((r) => setWho(r.assistant_name || "Atlas")).catch(() => undefined); }, []);
  useEffect(() => {
    let stop = false;
    api<{ id: number }[]>("/mail/accounts").then(async (accounts) => {
      const first = accounts[0];
      if (!first || stop) return;
      try {
        await api(`/mail/${first.id}/messages`);
      } catch (err) {
        if (!stop) setBroken(mailLine(err));
      }
    }).catch((err) => { if (!stop) setBroken(mailLine(err)); });
    return () => { stop = true; };
  }, []);
  useEffect(() => { api<{ id: number }>("/assistant/main").then((r) => setMainId(r.id)).catch(() => undefined); }, []);
  const freshChat = Boolean((location.state as { fresh?: boolean } | null)?.fresh);
  const listing = Boolean((location.state as { list?: boolean } | null)?.list);
  useEffect(() => {
    if (cid || freshChat || listing || busyRef.current) return;
    let stop = false;
    api<{ id: number }>("/assistant/main").then((r) => {
      if (!stop && location.pathname === "/assistant") navigate(`/assistant/${r.id}`, { replace: true });
    }).catch(() => undefined);
    return () => { stop = true; };
  }, [cid, freshChat, listing, location.pathname]);

  const loadConvs = () => api<Conv[]>("/conversations").then(setConvs).catch(toast.err);
  useEffect(() => { loadConvs(); }, []);
  const loadConv = (id: number) => {
    loadCached(`conv:${id}`, () => api<{ messages: Row[]; model: string }>(`/conversations/${id}`)).then((c) => {
      setMessages((cur) => mergeLoaded(cur, fromRows(c.messages, viaByReply.current)));
      setModel(c.model || "");
    }).catch(toast.err);
    api<Approval[]>(`/approvals?conversation_id=${id}`).then(setApprovals).catch(toast.err);
  };
  // Approvals raised elsewhere (the rooks terminal on this conversation) show up while the chat is open. A turn in this
  // tab says so itself (its approval_required event); for the rest the shell's pulse says when a call was held or
  // answered anywhere (its `held` revision), and only while something is held here is it also asked every 15 s.
  const loadApprovals = (id: number) => api<Approval[]>(`/approvals?conversation_id=${id}`).then((list) => setApprovals((cur) => {
    const ids = new Set(list.map((a) => a.id));
    const same = cur.length === list.length && cur.every((a) => ids.has(a.id));
    return same ? cur : list;
  })).catch(() => {});
  const holding = approvals.length > 0;
  useEffect(() => {
    if (!cid || !holding) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void loadApprovals(cid); }, HELD_POLL_MS);
    return () => clearInterval(t);
  }, [cid, holding]);
  // Replies that arrived another way (the terminal on this conversation, a job) join the thread: asked when the
  // pulse's `chats` revision moves, not on a timer.
  const loadOthers = (id: number) => api<{ messages: Row[] }>(`/conversations/${id}`).then((c) => {
    setMessages((cur) => {
      const known = new Set(cur.map((m) => m.id));
      const said = new Set(cur.filter((m) => m.role === "assistant").map((m) => m.content));
      const extra = fromRows(c.messages, viaByReply.current).filter((m) => m.role === "assistant" && !known.has(m.id) && !said.has(m.content));
      return extra.length ? [...cur, ...extra] : cur;
    });
  }).catch(() => undefined);
  useRevs((r, before) => {
    if (!cid || busyRef.current) return;
    if (r.held !== before.held) void loadApprovals(cid);
    if (r.chats !== before.chats) void loadOthers(cid);
  }, [cid]);
  useEffect(() => {
    // Opening the chat list while a reply is still being written must not wipe it.
    if (!cid && busyRef.current) return;
    setApprovals([]);
    setEditing(null);
    setOpenSteps({});
    if (!cid) return setMessages([]);
    // A chat you open again shows what it showed last time at once; the stored rows replace it when they arrive.
    const kept = peekCached<{ messages: Row[]; model: string }>(`conv:${cid}`);
    if (kept) { setMessages((cur) => mergeLoaded(cur, fromRows(kept.messages, viaByReply.current))); setModel(kept.model || ""); }
    loadConv(cid);
  }, [cid]);

  const decide = async (a: Approval, approve: boolean) => {
    try {
      const r = await api<{ status: string; result: string }>(`/approvals/${a.id}`, { method: "POST", body: { approve } });
      exit.run(a.id, () => setApprovals((xs) => xs.filter((x) => x.id !== a.id)));
      if (r.status === "failed") toast.err(r.result);
      if (cid) { loadConv(cid); void refreshHistory(cid); }
    } catch (e) { toast.err(e); }
  };
  // reduced motion (Appearance or the OS setting) jumps instead of animating the scroll on every streamed word
  // The thread stays pinned to the newest line while a reply streams in, unless you scrolled up to read (chat/scroll.ts).
  // Sending something pins it again.
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = endRef.current?.closest(".chat-scroll");
    if (!el) return;
    const onScroll = () => { pinnedRef.current = isPinned(el); };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [cid, messages.length > 0]);
  useEffect(() => {
    if (!pinnedRef.current) return;
    endRef.current?.scrollIntoView({ behavior: followBehavior(busyRef.current, motionOff()), block: "end" });
  }, [messages, live?.steps.length, live?.draft.length]);

  /** A job started on a surface: the Stage shows it (the Room, a browser, the desktop). */
  const openWatch = (w: Watch) => {
    if (!w.job_id) return;
    openStage({ surface: surfaceOf(w.surface), jobId: w.job_id, goal: w.goal || undefined });
  };

  /** Once the turn is done, the fresh messages take the ids the server stored them under (same keys, nothing re-mounts). */
  const adoptIds = async (id: number) => {
    try {
      const c = await api<{ messages: Row[]; model: string }>(`/conversations/${id}`);
      putCached(`conv:${id}`, c);
      if (!mounted.current) return;
      setMessages((cur) => adoptServerIds(cur, c.messages));
    } catch { /* the next load names them */ }
  };

  /** One streamed turn. echo: show the user's text as a fresh bubble (not on resend, where it's already on screen
   *  and stored). resend: the server skips saving the user message again. */
  const run = async (msg: string, opts: { echo?: boolean; resend?: boolean; files?: Att[] } = {}) => {
    busyRef.current = true;
    setBusy(true);
    setBusySince(Date.now());
    setEditing(null);
    setFresh(null);
    const turn0 = emptyTurn(cid);
    liveRef.current = turn0;
    setLive(turn0);
    pinnedRef.current = true; // what you just sent, and the reply to it, are shown
    if (opts.echo) {
      const uid = Date.now();
      setMessages((m) => [...m, { id: uid, key: `t${uid}`, role: "user", content: msg, tool_calls: [], name: "", attachments: opts.files }]);
    }
    let newId = cid;
    let stopped = false;
    let lastReply = "";
    let replyKey = "";
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const onEvent = (raw: StreamEvent) => {
      const ev = parseEvent(raw as Record<string, unknown>);
      if (!ev) { if (!raw.type && raw.error) toast.err(String(raw.error)); return; }
      const next = reduceTurn(liveRef.current ?? emptyTurn(cid), ev);
      liveRef.current = next;
      setLive(next);
      switch (ev.type) {
        case "start": newId = ev.conversation_id; void refreshPresence(); break; // the strip says "Thinking" now, not at the next tick
        case "approval_required": {
          setApprovals((a) => (a.some((x) => x.id === ev.approval.id) ? a : [...a, ev.approval]));
          if (inBackground()) void notify("Needs your OK", `${stepTitle(ev.approval.tool, ev.approval.args)}: ${ev.approval.reason || "waiting for your OK"}`, { tag: "approval" });
          break;
        }
        case "watch": openWatch(ev.watch); break;
        case "card": if (ev.card.kind === "watch" && ev.card.job_id) openWatch({ surface: ev.card.surface || "computer", job_id: ev.card.job_id, goal: ev.card.goal || "" }); break;
        case "message": {
          lastReply = ev.content;
          const mid = Date.now() + 1;
          replyKey = `t${mid}`;
          if (next.via) viaByReply.current.set(ev.content, next.via);
          setFresh({ key: replyKey, from: next.revealFrom });
          setOpenSteps((o) => ({ ...o, [replyKey]: true }));
          setMessages((m) => [...m, {
            id: mid, key: replyKey, role: "assistant", content: ev.content, tool_calls: [], name: "", via: next.via,
            choices: next.choices ?? undefined, cards: next.cards.length ? next.cards : undefined,
            steps: next.steps.length ? next.steps : undefined, notices: next.notices.length ? next.notices : undefined,
          }]);
          break;
        }
        case "done": {
          const key = replyKey;
          if (key) setMessages((m) => m.map((x) => (x.key === key ? { ...x, outcome: ev.done.outcome } : x)));
          break;
        }
        case "automate_offer": setOffer(ev.offer); break;
        case "stopped": stopped = true; break;
        case "error": toast.err(ev.error); break;
        default: break;
      }
    };
    try {
      await stream("/assistant/chat", { message: msg, conversation_id: cid, model: model || null, effort: isPlan ? effort : "", mode: workMode, resend: !!opts.resend, attachments: (opts.files ?? []).map((a) => a.id) }, onEvent, ctrl.signal);
    } catch {
      stopped = stopped || ctrl.signal.aborted; // the abort drops the fetch before the server's "stopped" line arrives
    }
    abortRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setLive(null);
    liveRef.current = null;
    void refreshPresence();
    if (!stopped && lastReply && inBackground()) void notify("Reply ready", lastReply.replace(/\s+/g, " ").slice(0, 160), { tag: "reply" });
    loadConvs();
    const doneCid = newId || cid;
    if (doneCid) forgetRuns(doneCid);
    if (stopped && doneCid) loadConv(doneCid); // pick up what the turn kept before it stopped
    else if (doneCid) { await adoptIds(doneCid); void refreshHistory(doneCid); }
    if (!stopped && newId && newId !== cid && mounted.current && pathRef.current.startsWith("/assistant")) navigate(`/assistant/${newId}`, { replace: true });
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

  /** A suggestion chip or a handed over sentence: send it as if typed. */
  const sendText = (msg: string) => {
    if (busy || att.uploading || !msg.trim()) return;
    askNotifyPermission();
    void run(msg.trim(), { echo: true });
  };

  // Home hands over a sentence and means it: send once, then drop the handoff so a refresh does not send it again.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!location.pathname.startsWith("/assistant")) return;
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
      if (cidRef.current) await api("/assistant/stop", { body: { conversation_id: cidRef.current } });
    } catch { /* the abort already ended our side */ }
  };
  const stopTurnRef = useRef(stopTurn);
  stopTurnRef.current = stopTurn;
  const newChat = () => navigate("/assistant", { state: { fresh: true } });
  const focusComposer = () => composerRef.current?.focus();

  // Keyboard, from the one shortcut list (lib/shortcuts.ts): Esc stops a running turn, Ctrl/⌘+/ goes to the message box.
  // Ctrl/⌘+Shift+O (a new chat) works on every page, so the shell reads it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (busyRef.current && isShortcut("stop", e)) { e.preventDefault(); void stopTurnRef.current(); return; }
      if (isShortcut("focus-composer", e)) { e.preventDefault(); composerRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

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

  useEffect(() => {
    if (!showRoutines) return;
    api<{ routines: Routine[] }>("/assistant/routines").then((r) => setRoutines(r.routines)).catch(toast.err);
  }, [showRoutines]);
  const title = cid === mainId ? who : (convs?.find((c) => c.id === cid)?.title ?? "New chat");
  const emptyLine = approvals.length > 0 ? "Something is waiting for your approval." : broken || undefined;

  return (
    <div className={`agents-chat chat-layout${listOpen ? " has-list" : ""}`}>
      <ChatList open={listOpen} id="chat-list" floating={narrow} onClose={() => setListOpen(false)} />
      <div className="agents-chat-main chat-main">
        <ThreadHeader
          title={title} cid={cid} listOpen={listOpen} onToggleList={toggleList}
          workMode={workMode} onMode={chooseMode} codeDepth={codeDepth.current} devTools={devTools}
          model={model} onModel={setModel} models={models} defaultRef={defaultRef} isPlan={isPlan} effort={effort} onEffort={setEffort}
          busy={busy} showRoutines={showRoutines} onRoutines={() => { setShowRoutines((v) => !v); setRoutines(null); }}
          onTerminal={() => api<{ command: string; expires_in: number }>("/assistant/handoff", { body: { conversation_id: cid } })
            .then((h) => { navigator.clipboard?.writeText(h.command); toast.ok(`Copied: ${h.command}`); })
            .catch(toast.err)}
          onBeside={async () => {
            try {
              const accounts = await api<{ id: number }[]>("/mail/accounts");
              const first = accounts[0];
              if (!first) { setBroken("No mailbox is connected."); return; }
              await api(`/mail/${first.id}/messages`);
              openBeside("/mail");
            } catch (err) {
              setBroken(mailLine(err));
            }
          }}
          onNewChat={newChat} onStop={() => void stopTurn()} onFocusComposer={focusComposer}
        />
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
        <div className="chat-stage">
          <Thread
            who={who} cid={cid} messages={messages} live={live} busy={busy} busySince={busySince}
            approvals={approvals} leaving={exit.leaving} onDecide={decide}
            fresh={fresh} onRevealDone={() => setFresh(null)}
            onPickChoice={pickChoice} onRegenerate={regenerate}
            editing={editing} editText={editText} onEditStart={(m) => { setEditing(m.id); setEditText(m.content); }} onEditChange={setEditText} onEditSave={saveEdit} onEditCancel={() => setEditing(null)}
            open={openSteps} onToggleSteps={(key) => setOpenSteps((o) => ({ ...o, [key]: !o[key] }))}
            empty={<EmptyChat who={who} line={emptyLine} onSend={sendText} disabled={busy || att.uploading} />}
            endRef={endRef}
          />
        </div>
        {offer && (
          <div className="card row chat-offer" style={{ alignItems: "center", gap: 10 }}>
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
        <Composer text={text} onText={setText} busy={busy} att={att} onSend={send} onStop={() => void stopTurn()} composerRef={composerRef} />
      </div>
    </div>
  );
}

export default function Assistant({ tab }: { tab: "chat" | "memory" | "settings" }) {
  const navigate = useNavigate();
  if (tab === "chat") return <Chat />;
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <button type="button" className="btn ghost sm" onClick={() => navigate("/assistant")}><ArrowLeft size={14} /> Chat</button>
        <h1 className="grow">{tab === "memory" ? "Memory" : "Chat settings"}</h1>
      </div>
      {tab === "memory" && <MemoryTab />}
      {tab === "settings" && <SettingsTab />}
    </div>
  );
}
