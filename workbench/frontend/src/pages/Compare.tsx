import { Clock, Columns3, Copy, Plus, RotateCcw, Send, Square, X } from "lucide-react";
import { FormEvent, useRef, useState } from "react";
import { stream, StreamEvent } from "../api";
import { Button, EmptyState, IconButton, Loading, Page, Textarea } from "../ui";
import { Markdown, ModelSelect, useModels, useToast } from "../util";
import { ButtonLink, Notice } from "./settings/index";

type Turn = { role: "user" | "assistant"; content: string };
type Column = { id: number; model: string; history: Turn[]; live: string; thinking: string; busy: boolean; error: string; stats: { ms?: number; first?: number | null; tokens?: number } };

let nextId = 1;
const blank = (model = ""): Column => ({ id: nextId++, model, history: [], live: "", thinking: "", busy: false, error: "", stats: {} });
const clean = (t: string) => t.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();

export default function Compare() {
  const { models, loading } = useModels();
  const [cols, setCols] = useState<Column[]>(() => [blank(), blank()]);
  const [prompt, setPrompt] = useState("");
  const [system, setSystem] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const aborts = useRef(new Map<number, AbortController>());
  const toast = useToast();

  const update = (id: number, fn: (c: Column) => Column) => setCols((cs) => cs.map((c) => (c.id === id ? fn(c) : c)));

  const runOne = async (col: Column, text: string) => {
    const ctrl = new AbortController();
    aborts.current.set(col.id, ctrl);
    const history: Turn[] = [...col.history, { role: "user", content: text }];
    update(col.id, (c) => ({ ...c, history, live: "", thinking: "", busy: true, error: "", stats: {} }));
    let out = "";
    const onEvent = (e: StreamEvent) => {
      if (e.error) update(col.id, (c) => ({ ...c, error: String(e.error) }));
      if (e.reasoning) { const r = e.reasoning; update(col.id, (c) => ({ ...c, thinking: c.thinking + r })); }
      if (e.delta) { out += e.delta; update(col.id, (c) => ({ ...c, live: out })); }
      if (e.done) update(col.id, (c) => ({ ...c, stats: { ms: e.ms, first: e.first_token_ms, tokens: e.usage?.completion_tokens } }));
    };
    try {
      await stream("/compare/stream", { model: col.model, messages: history, system }, onEvent, ctrl.signal);
    } catch {
      /* aborted */
    }
    update(col.id, (c) => ({ ...c, busy: false, live: "", history: out ? [...history, { role: "assistant", content: clean(out) }] : history }));
  };

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    const ready = cols.filter((c) => c.model);
    if (ready.length < 1) return toast.err("Pick at least one model");
    ready.forEach((c) => runOne(c, text));
    setPrompt("");
  };

  const stopAll = () => aborts.current.forEach((a) => a.abort());
  const reset = () => { stopAll(); setCols((cs) => cs.map((c) => ({ ...blank(c.model), id: c.id }))); };
  const busy = cols.some((c) => c.busy);

  return (
    <Page title="Compare models" wide className="st-page"
      description="Send the same prompt to several models and read the answers side by side. Each column keeps its own conversation."
      actions={<>
        <Button size="sm" variant={showSystem ? "secondary" : "ghost"} aria-pressed={showSystem} onClick={() => setShowSystem(!showSystem)}>System prompt</Button>
        <Button size="sm" icon={<RotateCcw size={14} />} onClick={reset} disabled={busy}>Reset</Button>
        <Button size="sm" icon={<Plus size={14} />} disabled={cols.length >= 4} onClick={() => setCols([...cols, blank()])}>Column</Button>
      </>}>
      {showSystem && <div className="st-gap-b"><Textarea label="System prompt" rows={3} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="Optional instructions applied to every model" /></div>}
      {loading ? <Loading rows={2} label="Loading models" /> : models.length === 0 ? (
        <EmptyState icon={<Columns3 size={22} />} title="No models to compare yet" line="Connect a model in Settings, or download one to this computer." action={<ButtonLink to="/settings?section=models">Open model settings</ButtonLink>} />
      ) : (
        <>
          <div className="st-compare">
            {cols.map((col) => (
              <div key={col.id} className="st-compare-col">
                <div className="st-key">
                  <div className="st-grow"><ModelSelect value={col.model} onChange={(v) => update(col.id, (c) => ({ ...c, model: v }))} models={models} allowDefault={false} /></div>
                  {cols.length > 1 && <IconButton size="sm" label="Remove this column" onClick={() => { aborts.current.get(col.id)?.abort(); setCols(cols.filter((c) => c.id !== col.id)); }}><X size={15} /></IconButton>}
                </div>
                <div className="st-compare-out" aria-live="polite">
                  {col.history.length === 0 && !col.busy && <p className="st-small">{col.model ? "Ready. Ask below." : "Pick a model."}</p>}
                  {col.history.map((t, i) => t.role === "user"
                    ? <div key={i} className="st-compare-user">{t.content}</div>
                    : <div key={i} className="st-compare-answer"><Markdown text={t.content} /><IconButton size="sm" label="Copy" onClick={() => navigator.clipboard.writeText(t.content)}><Copy size={12} /></IconButton></div>)}
                  {col.thinking && (
                    <details className="st-thinking" open={col.busy && !col.live}>
                      <summary>{col.busy && !col.live ? "Thinking…" : "Show reasoning"}</summary>
                      <div className="st-thinking-text">{col.thinking}</div>
                    </details>
                  )}
                  {col.busy && (col.live ? <Markdown text={clean(col.live) || "…"} /> : !col.thinking && <p className="st-small" role="status">Waiting for the first word…</p>)}
                  {col.error && <Notice tone="danger">{col.error}</Notice>}
                </div>
                {(col.stats.ms || col.busy) && (
                  <div className="st-compare-stats">
                    <Clock size={12} aria-hidden="true" />
                    {col.stats.ms ? <>{(col.stats.ms / 1000).toFixed(1)}s total{col.stats.first ? ` · ${(col.stats.first / 1000).toFixed(1)}s to first word` : ""}{col.stats.tokens ? ` · ${col.stats.tokens} tokens · ${Math.round(col.stats.tokens / (col.stats.ms / 1000))} per second` : ""}</> : "Running…"}
                  </div>
                )}
              </div>
            ))}
          </div>

          <form className="st-compare-ask" onSubmit={send}>
            <Textarea rows={2} aria-label="Ask all models" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ask all models… (Enter to send, Shift+Enter for a new line)"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
            {busy ? <Button icon={<Square size={15} />} onClick={stopAll}>Stop</Button> : <Button type="submit" variant="primary" icon={<Send size={15} />} disabled={!prompt.trim()}>Send</Button>}
          </form>
        </>
      )}
    </Page>
  );
}
