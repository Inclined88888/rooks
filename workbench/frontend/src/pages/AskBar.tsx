/**
 * The floating ask bar (feat/v02-anywhere-voice; Free). Opened over any app by the global shortcut (Option+Space on a
 * Mac, Alt+Space on Windows). It arrives with the text you had selected (or what you'd copied) and, if switched on, a
 * screenshot of the window. Ask about it or act on it, then paste the answer straight back.
 */
import { ArrowUp, Camera, ClipboardPaste, Copy, CornerDownLeft, FileText, MessageSquare, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, stream } from "../api";
import { inDesktopShell, invoke } from "../desktop";
import { Markdown, useToast } from "../util";
import { Button, Chip, IconButton, Textarea } from "../ui";
import { DictateButton } from "../voice/DictateButton";
import { handoffDraft } from "../voice/logic";
import "./agents/agents.css";
import "../voice/voice.css";

type Win = { id?: string | number; title?: string; app?: string } | null;
type Ctx = { text: string; source: "selection" | "clipboard" | "none"; window: Win; image: string };
type Turn = { role: "user" | "assistant"; content: string };
type Settings = { grab_selection: boolean; screenshot: boolean; shortcut: string; desk: boolean; desktop: boolean };

const QUICK: { id: string; label: string; needsText?: boolean }[] = [
  { id: "explain", label: "Explain" },
  { id: "summarise", label: "Summarise", needsText: true },
  { id: "reply", label: "Write a reply", needsText: true },
  { id: "fix", label: "Fix writing", needsText: true },
  { id: "translate", label: "Translate", needsText: true },
  { id: "next", label: "What next?" },
];

const EMPTY: Ctx = { text: "", source: "none", window: null, image: "" };

export default function AskBar() {
  const [ctx, setCtx] = useState<Ctx>(EMPTY);
  const [showText, setShowText] = useState(false);
  const [q, setQ] = useState("");
  const [history, setHistory] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const navigate = useNavigate();
  const desktop = inDesktopShell();

  const reset = useCallback(() => {
    abort.current?.abort();
    setAnswer(""); setAsked(""); setHistory([]); setQ(""); setShowText(false); setBusy(false);
    api<Ctx>("/anywhere/context").then((c) => setCtx(c.source === "none" && !c.image ? EMPTY : c)).catch(() => setCtx(EMPTY));
    setTimeout(() => input.current?.focus(), 30);
  }, []);

  useEffect(() => {
    document.title = "Ask";
    document.documentElement.classList.add("askbar-doc");
    reset();
    api<Settings>("/anywhere/settings").then(setSettings).catch(() => undefined);
    // The desktop shell calls this each time the shortcut shows the (already open) ask bar again
    (window as unknown as { __askBarOpen?: () => void }).__askBarOpen = reset;
    return () => document.documentElement.classList.remove("askbar-doc");
  }, [reset]);

  const close = useCallback((restore = false) => {
    abort.current?.abort();
    if (desktop) invoke("hide_ask_bar", { restoreFocus: restore }).catch(() => undefined);
    else navigate("/assistant");
  }, [desktop, navigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(true); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const ask = async (quick = "", e?: FormEvent) => {
    e?.preventDefault();
    const question = q.trim();
    if (busy || (!question && !quick)) return;
    const label = [QUICK.find((x) => x.id === quick)?.label, question].filter(Boolean).join(": ");
    const prior = answer ? [...history, { role: "user" as const, content: asked }, { role: "assistant" as const, content: answer }] : history;
    setHistory(prior); setAsked(label); setAnswer(""); setQ(""); setBusy(true);
    abort.current = new AbortController();
    let out = "";
    await stream("/anywhere/ask", { question, quick, text: prior.length ? "" : ctx.text, image: prior.length ? "" : ctx.image, window: ctx.window, history: prior }, (ev) => {
      if (ev.delta) { out += ev.delta; setAnswer(out); }
      if (ev.error) toast.err(String(ev.error));
    }, abort.current.signal).catch((err) => { if ((err as Error).name !== "AbortError") toast.err(err); });
    setBusy(false);
  };

  const paste = async () => {
    if (!answer) return;
    try {
      if (settings?.desk && desktop) {
        // Rooks Desk types it into the app you came from: get out of the way first
        await invoke("hide_ask_bar", { restoreFocus: true });
        await new Promise((r) => setTimeout(r, 250));
        const r = await api<{ pasted?: boolean; detail?: string }>("/anywhere/paste", { body: { text: answer, window: ctx.window } });
        if (!r.pasted) await invoke("show_main_window", {}).catch(() => undefined);
        return;
      }
      // copied here first, while the click still counts: WebKit (the Rooks app) refuses a clipboard write after an await
      const local = navigator.clipboard?.writeText(answer).then(() => true, () => false) ?? Promise.resolve(false);
      const r = await api<{ copied: boolean; pasted: boolean; detail: string }>("/anywhere/paste", { body: { text: answer, window: ctx.window } });
      if (!r.copied && !(await local)) await navigator.clipboard.writeText(answer);
      toast.ok(r.pasted ? "Pasted." : `Copied. Press ${/Mac/.test(navigator.platform) ? "⌘V" : "Ctrl+V"} in your app to paste.`);
      setTimeout(() => close(true), 1400);
    } catch (e) { toast.err(e); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(answer); toast.ok("Copied"); } catch { toast.err("Couldn't copy. Select the text and copy it."); }
  };

  const toChat = () => {
    const draft = handoffDraft(asked || q, ctx.text, answer);
    if (desktop) invoke("show_main_window", { draft }).catch((e) => toast.err(e));
    else navigate("/assistant", { state: { draft } });
  };

  const useClipboard = async () => {
    try { setCtx(await api<Ctx>("/anywhere/grab", { body: { screenshot: false } })); } catch (e) { toast.err(e); }
  };

  const toggleShot = async () => {
    const next = !settings?.screenshot;
    try {
      setSettings(await api<Settings>("/anywhere/settings", { method: "PUT", body: { screenshot: next } }));
      toast.ok(next ? "Next time, I'll include a picture of the window." : "No screenshots from now on.");
    } catch (e) { toast.err(e); }
  };

  const from = ctx.window?.app || ctx.window?.title || "";
  const hasText = !!ctx.text.trim();
  const size = ctx.text.length > 999 ? `${Math.round(ctx.text.length / 100) / 10}k` : String(ctx.text.length);
  return (
    <div className="askbar" role="dialog" aria-label="Ask about what's on screen">
      <div className="askbar-drag" data-tauri-drag-region>
        <span className="askbar-title" data-tauri-drag-region>Ask</span>
        <span className="askbar-hint ag-grow" data-tauri-drag-region>{from ? `over ${from}` : ""}</span>
        <IconButton size="sm" label="Close (Esc)" title="Close (Esc)" onClick={() => close(true)}><X size={16} /></IconButton>
      </div>

      <div className="askbar-context">
        {hasText
          ? <Chip icon={<FileText size={14} />} active={showText} onClick={() => setShowText((v) => !v)} onRemove={() => setCtx({ ...ctx, text: "", source: "none" })} removeLabel="Leave out the text">
            {ctx.source === "selection" ? "Selected text" : "What you copied"} · {size} characters
          </Chip>
          : <Chip icon={<ClipboardPaste size={14} />} onClick={useClipboard}>Nothing selected. Use what I copied</Chip>}
        {ctx.image && (
          <Chip icon={<img src={ctx.image} alt="" className="askbar-thumb" />} onRemove={() => setCtx({ ...ctx, image: "" })} removeLabel="Leave out the screenshot">Screenshot</Chip>
        )}
        {settings?.desk && (
          <Chip icon={<Camera size={14} />} active={settings.screenshot} onClick={toggleShot}
            title="Include a picture of the window you were in each time you press the shortcut">
            {settings.screenshot ? "Screenshots on" : "Screenshots off"}
          </Chip>
        )}
      </div>
      {showText && hasText && <pre className="askbar-text">{ctx.text}</pre>}

      {!asked && (
        <div className="askbar-quick" role="group" aria-label="Quick actions">
          {QUICK.filter((x) => !x.needsText || hasText).map((x) => (
            <Chip key={x.id} onClick={busy ? undefined : () => ask(x.id)}>{x.label}</Chip>
          ))}
        </div>
      )}

      {asked && (
        <div className="askbar-answer" aria-live="polite">
          <p className="askbar-hint askbar-asked">{asked}</p>
          {answer ? <Markdown text={answer} /> : <p className="askbar-hint" role="status">Thinking…</p>}
        </div>
      )}

      <form className="askbar-input" onSubmit={(e) => ask("", e)}>
        <Textarea ref={input} rows={1} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Your question"
          placeholder={asked ? "Ask a follow-up" : hasText ? "Ask about this, or tell me what to do with it" : "Ask anything"}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(""); } }} />
        <DictateButton onText={(t) => { setQ((v) => (v ? v + " " : "") + t); input.current?.focus(); }} />
        <Button type="submit" variant="primary" icon={<ArrowUp size={16} />} busy={busy} disabled={!q.trim()} aria-label={busy ? "Thinking" : "Ask"}>{busy ? "Thinking…" : "Ask"}</Button>
      </form>

      {answer && !busy && (
        <div className="askbar-actions">
          <Button size="sm" variant="primary" icon={<CornerDownLeft size={14} />} onClick={paste} title={settings?.desk ? "Put the answer into the app you came from" : "Copy it, ready to paste"}>Paste back</Button>
          <Button size="sm" icon={<Copy size={14} />} onClick={copy}>Copy</Button>
          <span className="askbar-hint ag-grow" />
          <Button size="sm" variant="ghost" icon={<MessageSquare size={14} />} onClick={toChat} title="Carry on in Chat, where I can use your tools (with your OK)">Do it in Chat</Button>
        </div>
      )}
      {toast.node}
    </div>
  );
}
