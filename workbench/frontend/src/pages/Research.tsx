// Research: ask a question, I search, read and write a report with sources. Premium pass (package C).
import { ExternalLink, FileText, Search, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { Markdown, ModelSelect, relTime, useModels, useToast } from "../util";
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, List, Loading, Page, Row, Select, Textarea } from "../ui";
import { Gate, Split, StatusText, plainError, useLoad } from "./agents/kit";
import { WebSearchSetup } from "./ModelSignIn";

type Item = { id: number; question: string; model: string; status: "running" | "done" | "error"; progress: string; created_at: string };
type Full = Item & { report: string; error: string; sources: { title: string; url: string; snippet: string }[] };

export default function Research() {
  const { id } = useParams();
  const navigate = useNavigate();
  const list = useLoad(() => api<Item[]>("/research"), []);
  const [current, setCurrent] = useState<Full | null>(null);
  const [openErr, setOpenErr] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const [question, setQuestion] = useState("");
  const [depth, setDepth] = useState(3);
  const [model, setModel] = useState("");
  const { models } = useModels();
  const toast = useToast();

  const loadList = list.reload;
  const lookUp = async () => {
    const goal = (current?.question || question).trim();
    if (goal.length < 3) return;
    const start = current?.sources?.[0]?.url;
    try {
      await api("/browser/jobs", { body: { goal, ...(start ? { start_url: start } : {}) } });
      toast.ok("Looking that up. I'll wait before I click anything.");
    } catch (e) {
      toast.err(e);
    }
  };
  useEffect(() => {
    setOpenErr(null);
    if (!id) return setCurrent(null);
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api<Full>(`/research/${id}`);
        if (stop) return;
        setCurrent(r); setOpenErr(null);
        if (r.status === "running") timer = setTimeout(poll, 1500);
        else loadList();
      } catch (e) {
        if (!stop) setOpenErr(e);
      }
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [id, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<Item>("/research", { body: { question, depth, model: model || null } });
      setQuestion("");
      loadList();
      navigate(`/research/${r.id}`);
    } catch (err) {
      toast.err(err);
    }
  };
  const save = async () => {
    try {
      const d = await api<{ id: number }>(`/research/${current!.id}/save`, { method: "POST" });
      navigate(`/documents/${d.id}`);
    } catch (e) {
      toast.err(e);
    }
  };
  const remove = async (rid: number) => {
    try { await api(`/research/${rid}`, { method: "DELETE" }); } catch (e) { toast.err(e); return; }
    if (current?.id === rid) navigate("/research");
    loadList();
  };
  const STATUS: Record<Item["status"], string> = { running: "Working", done: "Done", error: "Stopped" };

  return (
    <Page wide className="ag-page rs-page" title="Research" description="Ask a question. I search the web, read the pages and write a report with the sources.">
      <div className="ag-stack-lg">
        <Card><WebSearchSetup compact /></Card>
        <Card as="section" aria-label="New research">
          <form className="ag-form" onSubmit={start}>
            <Textarea aria-label="Your question" rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What do you want to know? Be specific: scope, timeframe, region…" />
            <div className="ag-bar">
              <div className="rs-model"><ModelSelect value={model} onChange={setModel} models={models} /></div>
              <Select aria-label="Depth" className="rs-depth" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                <option value={1}>Quick (2 searches)</option><option value={3}>Standard (4)</option><option value={5}>Deep (6)</option>
              </Select>
              <span className="ag-bar-end"><Button type="submit" variant="primary" icon={<Search size={14} />} disabled={question.trim().length < 5}>Start research</Button></span>
            </div>
          </form>
        </Card>

        <Split solo={!id && list.data?.length === 0} list={
          <Gate state={list} rows={4}>{(items) => items.length === 0
            ? <EmptyState icon={<Search size={20} />} title="No research yet" line="Ask a question above to start your first report." />
            : <List className="ag-list" label="Reports">
              {items.map((r) => (
                <Row key={r.id} active={current?.id === r.id} onClick={() => navigate(`/research/${r.id}`)} title={r.question}
                  meta={<StatusText live={r.status === "running"}>{STATUS[r.status] ?? r.status} · {relTime(r.created_at)}</StatusText>}
                  actions={<IconButton size="sm" label="Delete this report" onClick={() => remove(r.id)}><Trash2 size={14} /></IconButton>} />
              ))}
            </List>}
          </Gate>
        }>
          {!id && <Card>{list.data?.length === 0
            ? <EmptyState icon={<Search size={20} />} title="No research yet" line="Ask a question above to start your first report." />
            : <EmptyState icon={<FileText size={20} />} title="Pick a report or start a new one" line="Reports you start appear in the list." />}</Card>}
          {id && !current && !openErr && <Card><Loading rows={4} /></Card>}
          {id && !!openErr && !current && <ErrorState title="That report did not open" line={plainError(openErr)} onRetry={() => setTick((t) => t + 1)} />}
          {current && (
            <Card as="article" className="ag-stack">
              {current.status === "running" && <span className="sr-only" role="status">Research in progress</span>}
              <div className="ag-panel-head">
                <h2 className="ag-title ag-grow">{current.question}</h2>
                <div className="ag-bar">
                  <Button size="sm" icon={<Search size={14} />} onClick={lookUp} disabled={current.question.trim().length < 3}>Look this up</Button>
                  {current.status === "done" && <Button size="sm" icon={<FileText size={14} />} onClick={save}>Save to documents</Button>}
                </div>
              </div>
              {current.status === "running" && <StatusText live>{current.progress || "Working"}</StatusText>}
              {current.status === "error" && <ErrorState title="The research stopped" line={current.error || "Try again with a narrower question."} />}
              {current.status === "done" && <Markdown text={current.report} />}
              {current.status !== "done" && current.sources.length > 0 && (
                <div className="ag-stack">
                  <h3 className="ag-h3">Sources found</h3>
                  <ol className="rs-sources">
                    {current.sources.map((s, i) => (
                      <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer noopener"><Badge>{i + 1}</Badge><span className="ag-grow">{s.title || "Untitled page"}</span><ExternalLink size={12} aria-hidden="true" /></a></li>
                    ))}
                  </ol>
                </div>
              )}
              {current.status === "done" && <p className="ag-note">Check claims against the linked sources before relying on them. Small local models can misread pages.</p>}
              <details className="rs-advanced"><summary>Advanced</summary><p className="ag-meta ag-mono">{current.model}</p></details>
            </Card>
          )}
        </Split>
      </div>
    </Page>
  );
}
