import { ArrowLeft, FileText, NotebookPen, PenLine, Pin, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, Doc, stream } from "../api";
import { Button, Card, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Select, Tabs } from "../ui";
import { Markdown, relTime, useModels, useToast } from "../util";
import { ModelPicker, plainError, Split } from "./day/parts";

const ACTIONS = [
  { id: "improve", label: "Improve writing" },
  { id: "fix", label: "Fix grammar" },
  { id: "shorten", label: "Make shorter" },
  { id: "expand", label: "Expand" },
  { id: "summarize", label: "Summarize" },
  { id: "continue", label: "Continue writing" },
  { id: "outline", label: "Draft outline" },
] as const;

function Editor({ doc, onSaved, onDeleted, onBack }: { doc: Doc; onSaved: (d: Doc) => void; onDeleted: () => void; onBack: () => void }) {
  const [title, setTitle] = useState(doc.title);
  const [body, setBody] = useState(doc.body);
  const [tags, setTags] = useState(doc.tags);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState<"idle" | "pending" | "saving" | "saved">("idle");
  const [assist, setAssist] = useState<{ action: string; result: string; busy: boolean; thinking?: boolean; range: [number, number] } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [model, setModel] = useState("");
  const { models } = useModels();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const toast = useToast();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaving("pending");
    const t = setTimeout(async () => {
      setSaving("saving");
      try {
        const d = await api<Doc>(`/docs/${doc.id}`, { method: "PATCH", body: { title, body, tags } });
        onSaved(d);
        setSaving("saved");
      } catch (e) {
        toast.err(e);
        setSaving("idle");
      }
    }, 700);
    return () => clearTimeout(t);
  }, [title, body, tags]); // eslint-disable-line react-hooks/exhaustive-deps

  const runAssist = async (action: string) => {
    const el = textRef.current;
    let [start, end] = el && !preview ? [el.selectionStart, el.selectionEnd] : [0, 0];
    if (start === end || action === "continue" || action === "outline") [start, end] = [0, body.length];
    const text = action === "outline" && !body.trim() ? title : body.slice(start, end);
    if (!text.trim() && action !== "custom") return toast.err("Write something first, or select text to work on.");
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAssist({ action, result: "", busy: true, range: action === "continue" ? [body.length, body.length] : [start, end] });
    let out = "";
    await stream("/ai/assist", { action, text: text || title, instruction, model: model || null }, (e) => {
      if (e.error) toast.err(String(e.error));
      if (e.reasoning) setAssist((a) => (a && !a.thinking ? { ...a, thinking: true } : a));
      if (e.delta) {
        out += e.delta;
        setAssist((a) => (a ? { ...a, result: out } : a));
      }
    }, ctrl.signal).catch(() => undefined);
    setAssist((a) => (a ? { ...a, busy: false } : a));
  };

  const apply = (mode: "replace" | "insert") => {
    if (!assist) return;
    const [s, e] = assist.range;
    const result = assist.result.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    setBody(mode === "replace" ? body.slice(0, s) + result + body.slice(e) : body.slice(0, e) + (body.slice(0, e).endsWith("\n") ? "\n" : "\n\n") + result + body.slice(e));
    setAssist(null);
  };

  const togglePin = async () => {
    try { onSaved(await api<Doc>(`/docs/${doc.id}`, { method: "PATCH", body: { pinned: !doc.pinned } })); } catch (e) { toast.err(e); }
  };
  const remove = async () => {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    try { await api(`/docs/${doc.id}`, { method: "DELETE" }); onDeleted(); } catch (e) { toast.err(e); }
  };
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const status = saving === "saving" ? "Saving…" : saving === "pending" ? "Edited" : saving === "saved" ? "Saved" : "";

  return (
    <div className="day-doc">
      <div className="day-doc-bar" role="toolbar" aria-label="Writing tools">
        <IconButton className="day-phone-only" label="Back to the list" size="sm" onClick={onBack}><ArrowLeft size={16} /></IconButton>
        <Tabs label="Write or preview" size="sm" value={preview ? "preview" : "write"} onChange={(v) => setPreview(v === "preview")} items={[{ id: "write", label: "Write" }, { id: "preview", label: "Preview" }]} />
        <ModelPicker value={model} onChange={setModel} models={models} />
        <Select aria-label="Writing help" className="day-assist-pick" value="" onChange={(e) => e.target.value && void runAssist(e.target.value)}>
          <option value="">Writing help…</option>
          {ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </Select>
        <span className="day-grow" />
        <span className="day-hint day-doc-status" aria-live="polite">{status}{status ? " · " : ""}{words} words</span>
        <IconButton label={doc.pinned ? "Unpin" : "Pin"} size="sm" active={!!doc.pinned} onClick={() => void togglePin()}><Pin size={15} /></IconButton>
        <IconButton label="Delete" size="sm" onClick={() => void remove()}><Trash2 size={15} /></IconButton>
      </div>
      <div className="day-doc-page">
        <input className="day-doc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" aria-label="Title" />
        <input className="day-doc-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Add tags, comma separated" aria-label="Tags" />
        <form className="day-add-row" onSubmit={(e) => { e.preventDefault(); if (instruction.trim()) void runAssist("custom"); }}>
          <Input className="day-grow" value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="Describe an edit"
            placeholder="Describe an edit, e.g. make it more formal, or add a conclusion" />
          <Button type="submit" icon={<PenLine size={15} />} disabled={!instruction.trim()}>Apply</Button>
        </form>
        {assist && (
          <Card className="day-assist-result" aria-busy={assist.busy || undefined}>
            <div className="day-assist-head">
              <strong>{ACTIONS.find((a) => a.id === assist.action)?.label ?? "Custom edit"}</strong>
              {assist.busy && <span className="day-hint" role="status">{assist.thinking && !assist.result ? "Thinking…" : "Writing…"}</span>}
              <span className="day-grow" />
              <IconButton label="Close" size="sm" onClick={() => { abortRef.current?.abort(); setAssist(null); }}><X size={15} /></IconButton>
            </div>
            <Markdown text={assist.result.replace(/<think>[\s\S]*?(<\/think>|$)/g, "") || (assist.thinking ? "*Thinking…*" : "…")} />
            {!assist.busy && assist.result && (
              <div className="day-actions">
                <Button variant="primary" size="sm" onClick={() => apply("replace")}>{assist.action === "continue" ? "Insert" : "Replace"}</Button>
                {assist.action !== "continue" && <Button size="sm" onClick={() => apply("insert")}>Insert below</Button>}
                <Button variant="ghost" size="sm" onClick={() => setAssist(null)}>Discard</Button>
              </div>
            )}
          </Card>
        )}
        {preview ? <Markdown className="day-doc-preview" text={body || "*Nothing here yet.*"} /> : (
          <textarea ref={textRef} className="day-doc-body" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Text"
            placeholder="Start writing. Markdown works. Select text before using writing help to work on just that part." />
        )}
      </div>
    </div>
  );
}

export default function Docs({ kind }: { kind: "note" | "document" }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [list, setList] = useState<Doc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [problem, setProblem] = useState("");
  const [q, setQ] = useState("");
  const [current, setCurrent] = useState<Doc | null>(null);
  const toast = useToast();
  const base = kind === "note" ? "/notes" : "/documents";
  const Icon = kind === "note" ? NotebookPen : FileText;
  const plural = kind === "note" ? "Notes" : "Documents";

  const load = () => {
    setProblem("");
    return api<Doc[]>(`/docs?kind=${kind}&q=${encodeURIComponent(q)}`).then(setList)
      .catch((e) => setProblem(plainError(e, `Your ${plural.toLowerCase()} did not load.`))).finally(() => setLoaded(true));
  };
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [q, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!id) return setCurrent(null);
    api<Doc>(`/docs/${id}`).then(setCurrent).catch(() => navigate(base));
  }, [id, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    try {
      const d = await api<Doc>("/docs", { body: { kind, title: kind === "note" ? "New note" : "Untitled document" } });
      setList((l) => [d, ...l]);
      navigate(`${base}/${d.id}`);
    } catch (e) { toast.err(e); }
  };
  const newLabel = kind === "note" ? "New note" : "New document";

  const listPane = (
    <>
      <div className="day-split-tools">
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${plural.toLowerCase()}`} aria-label={`Search ${plural.toLowerCase()}`} />
      </div>
      <div className="day-split-scroll">
        {!loaded && <Loading rows={5} label={`Loading ${plural.toLowerCase()}`} />}
        {loaded && problem && <div className="day-pad"><ErrorState title={`${plural} did not load`} line={problem} onRetry={() => void load()} /></div>}
        {loaded && !problem && list.length === 0 && (
          <EmptyState icon={<Icon size={22} />} title={q ? "No matches" : `No ${kind}s yet`} line={q ? "Try other words." : undefined}
            action={q ? <Button size="sm" onClick={() => setQ("")}>Clear the search</Button> : <Button size="sm" icon={<Plus size={14} />} onClick={() => void create()}>{newLabel}</Button>} />
        )}
        {list.length > 0 && !problem && (
          <List label={plural}>
            {list.map((d) => (
              <Row key={d.id} active={current?.id === d.id} onClick={() => navigate(`${base}/${d.id}`)}
                title={<>{d.title}{!!d.pinned && <Pin size={12} aria-label="Pinned" className="day-pin" />}</>}
                meta={`${relTime(d.updated_at)}${d.tags ? ` · ${d.tags}` : ""} · ${d.preview?.replace(/[#*_>`]/g, "").trim() || "Empty"}`} />
            ))}
          </List>
        )}
      </div>
    </>
  );

  return (
    <Page title={plural} wide className="day-page"
      description={kind === "document" ? "Longer writing lives here. Research reports can be saved here too." : "Quick thoughts, meeting notes, ideas. Chat can search these and add to them."}
      actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => void create()}>{newLabel}</Button>}>
      {loaded && !problem && !q && list.length === 0 && !current
        ? <EmptyState icon={<Icon size={24} />} title={`No ${kind}s yet`} line={kind === "note" ? "Write one here, or ask in Chat to take a note." : "Write one here, or save a research report."}
            action={<Button icon={<Plus size={14} />} onClick={() => void create()}>{newLabel}</Button>} />
        : <Split label={plural} picked={!!current} list={listPane} className="day-split-doc"
        main={current ? (
          <Editor key={current.id} doc={current} onSaved={(d) => { setCurrent(d); setList((l) => l.map((x) => (x.id === d.id ? { ...x, ...d, preview: d.body.slice(0, 240) } : x))); }}
            onDeleted={() => { setCurrent(null); navigate(base); void load(); }} onBack={() => { setCurrent(null); navigate(base); }} />
        ) : (
          <EmptyState icon={<Icon size={24} />} title={`Pick a ${kind} or start a new one`} action={<Button size="sm" icon={<Plus size={14} />} onClick={() => void create()}>{newLabel}</Button>} />
        )} />}
    </Page>
  );
}
