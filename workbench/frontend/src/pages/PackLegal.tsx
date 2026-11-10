// Legal pack: clause library, compare/redline, defined terms, cross-references, citations, matter timeline (feat/v02-packs).
// Every result carries the not-legal-advice notice and its sources.
import { useCallback, useEffect, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { api } from "../api";
import { FilePick, NotAdvice, PackGate, copy, download, useFiles } from "../packs/shared";
import { Markdown, useToast } from "../util";
import { ApiError } from "../api";
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, Input, Loading, Page, Tabs, Textarea } from "../ui";
import { plainError } from "./agents/kit";
import "../packs/packs.css";

type Term = { term: string; defined_at?: string; first_used?: string; uses?: number };
type Check = {
  document: string; summary: string; not_legal_advice: string;
  defined_terms: { defined: Term[]; used_not_defined: Term[]; defined_not_used: Term[]; note: string };
  cross_references: { checked: number; broken: { reference: string; where: string; problem: string }[] };
  citations: { citations: { kind: string; citation: string; where: string; problems: string[]; source: string }[]; note: string };
};
type Clause = { id: number; title: string; body: string; tags: string; uses: number; source: string };
type Event = { date: string; event: string; as_written: string; source: string; ambiguous: boolean };
type Tab = "check" | "compare" | "timeline" | "clauses";

export default function PackLegal() {
  const [tab, setTab] = useState<Tab>("check");
  const [gate, setGate] = useState<unknown>(null);
  const [err, setErr] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const toast = useToast();
  const files = useFiles();
  const load = useCallback(() => {
    setErr(null);
    api<{ notice: string }>("/packs/legal/settings").then((s) => setNotice(s.notice))
      .catch((e) => (e instanceof ApiError && (e.status === 402 || e.status === 409) ? setGate(e) : setErr(e)));
  }, []);
  useEffect(load, [load]);
  const head = { kicker: "Legal pack", title: "Documents and matters", description: "Checks that catch the slips a second reader would, each one with where it is in the document." };
  if (gate) return <Page className="ag-page" {...head}><PackGate error={gate} packId="legal" name="Legal pack" /></Page>;
  if (err) return <Page className="ag-page" {...head}><ErrorState title="The Legal pack did not open" line={plainError(err)} onRetry={load} /></Page>;
  if (notice === null) return <Page className="ag-page" {...head}><Loading rows={4} /></Page>;
  const tabs: [Tab, string][] = [["check", "Check a document"], ["compare", "Compare versions"], ["timeline", "Matter timeline"], ["clauses", "Clause library"]];
  return (
    <Page wide className="ag-page pk-page" {...head}
      actions={<Tabs label="Legal pack" value={tab} onChange={(v) => setTab(v as Tab)} items={tabs.map(([id, label]) => ({ id, label }))} />}>
      {notice && <NotAdvice text={notice} />}
      {tab === "check" && <CheckTab files={files} toast={toast} />}
      {tab === "compare" && <CompareTab files={files} toast={toast} />}
      {tab === "timeline" && <TimelineTab files={files} toast={toast} />}
      {tab === "clauses" && <Clauses toast={toast} />}
    </Page>
  );
}

type Ctx = { files: ReturnType<typeof useFiles>; toast: ReturnType<typeof useToast> };

function CheckTab({ files, toast }: Ctx) {
  const [file, setFile] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [r, setR] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { setR(await api<Check>("/packs/legal/check", { body: { file_id: file, text } })); } catch (e) { toast.err(e); } setBusy(false); };
  return (
    <div className="pk-two">
      <Card className="pk-stack">
        <h2 className="ag-h3">Document</h2>
        <FilePick label="Pick a contract or document" value={file} onChange={setFile} files={files.files} onAdded={files.reload} accept=".docx,.pdf,.txt,.md,.rtf,.doc" />
        <Textarea aria-label="Document text" rows={6} placeholder="…or paste the text" value={text} onChange={(e) => setText(e.target.value)} disabled={!!file} />
        <div className="ag-bar"><Button variant="primary" busy={busy} disabled={!file && !text.trim()} onClick={go}>{busy ? "Checking…" : "Check"}</Button></div>
      </Card>
      {r ? (
        <Card className="pk-stack">
          <p className="ag-meta">{r.document}</p>
          <p className="ag-body">{r.summary}</p>
          <Section title="Used like defined terms, but not defined" note={r.defined_terms.note}
            items={r.defined_terms.used_not_defined.map((t) => ({ main: `${t.term} (${t.uses} ${t.uses === 1 ? "use" : "uses"})`, where: t.first_used ?? "" }))} />
          <Section title="Defined but never used" items={r.defined_terms.defined_not_used.map((t) => ({ main: t.term, where: t.defined_at ?? "" }))} />
          <Section title="Cross-references that point nowhere" items={r.cross_references.broken.map((b) => ({ main: `${b.reference}: ${b.problem}`, where: b.where }))} />
          <Section title="Citations" note={r.citations.note} items={r.citations.citations.map((c) => ({
            main: `${c.citation} · ${c.kind}${c.problems.length ? ` · ${c.problems.join("; ")}` : ""}`, where: c.where, link: c.source, bad: c.problems.length > 0 }))} />
          <details className="ag-advanced"><summary>{r.defined_terms.defined.length} defined terms found</summary>
            {r.defined_terms.defined.map((t) => <div key={t.term} className="pk-find"><span>{t.term} · used {t.uses}×</span><span className="where">{t.defined_at}</span></div>)}</details>
        </Card>
      ) : <Card><EmptyState title="Nothing checked yet" line="Results show here, each with its place in the document." /></Card>}
    </div>
  );
}

function Section({ title, note, items }: { title: string; note?: string; items: { main: string; where: string; link?: string; bad?: boolean }[] }) {
  return (
    <div>
      <p className="ag-label">{title} · {items.length}</p>
      {!items.length ? <p className="ag-note">None found.</p> : items.map((x, i) => (
        <div key={i} className="pk-find">
          <span className={x.bad ? "pk-err" : ""}>{x.main}</span>
          <span className="where">{x.where}{x.link && <> · <a href={x.link} target="_blank" rel="noreferrer">check the source</a></>}</span>
        </div>
      ))}
      {note && <p className="ag-meta">{note}</p>}
    </div>
  );
}

type Cmp = { a: string; b: string; summary: string; text_changes: { change: string; where_before: string; where_after: string; redline: string }[]; report?: { download: string } };

function CompareTab({ files, toast }: Ctx) {
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [r, setR] = useState<Cmp | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="pk-stack">
      <Card className="pk-stack">
        <div className="ag-two">
          <FilePick label="Older version" value={a} onChange={setA} files={files.files} onAdded={files.reload} />
          <FilePick label="Newer version" value={b} onChange={setB} files={files.files} onAdded={files.reload} />
        </div>
        <div className="ag-bar"><Button variant="primary" disabled={!a || !b} busy={busy} onClick={async () => {
          setBusy(true); try { setR(await api<Cmp>("/packs/legal/compare", { body: { a, b } })); } catch (e) { toast.err(e); } setBusy(false);
        }}>{busy ? "Comparing…" : "Compare"}</Button>
        {r?.report && <Button onClick={() => download(r.report!.download)}>Download Word redline</Button>}</div>
      </Card>
      {r && <Card className="pk-stack">
        <p className="ag-body">{r.summary}</p>
        {r.text_changes.map((c, i) => (
          <div key={i} className="pk-find">
            <span className="where">{c.change} · {r.a} {c.where_before || "—"} → {r.b} {c.where_after || "—"}</span>
            <Markdown text={c.redline} className="pk-redline" />
          </div>
        ))}
      </Card>}
    </div>
  );
}

function TimelineTab({ files, toast }: Ctx) {
  const [chosen, setChosen] = useState<number[]>([]);
  const [text, setText] = useState("");
  const [dayFirst, setDayFirst] = useState(true);
  const [r, setR] = useState<{ entries: Event[]; note: string; ambiguous: number } | null>(null);
  const [busy, setBusy] = useState("");
  const body = { file_ids: chosen, text, day_first: dayFirst };
  return (
    <div className="pk-two">
      <Card className="pk-stack">
        <h2 className="ag-h3">Documents in this matter</h2>
        <div className="pk-list pk-scroll">
          {files.files.map((f) => (
            <label key={f.id} className="pk-item"><input type="checkbox" checked={chosen.includes(f.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, f.id] : chosen.filter((x) => x !== f.id))} />
              <span className="grow">{f.name}</span></label>
          ))}
          {!files.files.length && <p className="ag-note">Add documents in Files first, or paste text below.</p>}
        </div>
        <Textarea aria-label="Matter text" rows={4} placeholder="…or paste text (emails, notes)" value={text} onChange={(e) => setText(e.target.value)} disabled={chosen.length > 0} />
        <label className="ag-check"><input type="checkbox" checked={dayFirst} onChange={(e) => setDayFirst(e.target.checked)} /> Read 03/04/2025 as 3 April (day first)</label>
        <div className="ag-bar">
          <Button variant="primary" busy={busy === "t"} disabled={(!!busy && busy !== "t") || (!chosen.length && !text.trim())} onClick={async () => { setBusy("t"); try { setR(await api("/packs/legal/timeline", { body })); } catch (e) { toast.err(e); } setBusy(""); }}>{busy === "t" ? "Reading…" : "Build timeline"}</Button>
          {r && <Button busy={busy === "w"} disabled={!!busy && busy !== "w"} onClick={async () => { setBusy("w"); try { download((await api<{ download: string }>("/packs/legal/timeline/report", { body })).download); } catch (e) { toast.err(e); } setBusy(""); }}>Word report</Button>}
        </div>
      </Card>
      <Card>
        {!r ? <EmptyState title="No timeline yet" line="Every dated event, in order, with the passage it came from." /> : <>
          <p className="ag-meta">{r.entries.length} events · {r.note}</p>
          <ol className="pk-timeline">
            {r.entries.map((e, i) => (
              <li key={i}><div className="d">{new Date(e.date + "T00:00").toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}
                {e.ambiguous && <Badge tone="warn">Check the date</Badge>}</div>
                <p className="ag-body">{e.event}</p><p className="ag-meta">{e.source} · written “{e.as_written}”</p></li>
            ))}
          </ol>
        </>}
      </Card>
    </div>
  );
}

function Clauses({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<Clause[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [edit, setEdit] = useState<Partial<Clause> | null>(null);
  const load = useCallback(() => api<Clause[]>(`/packs/legal/clauses?q=${encodeURIComponent(q)}`).then((l) => { setList(l); setErr(null); }).catch(setErr), [q]);
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); load(); } catch (e) { toast.err(e); } };
  useEffect(() => { load(); }, [load]);
  return (
    <div className="pk-two">
      <Card className="pk-stack">
        <div className="ag-bar"><div className="ag-grow"><Input placeholder="Search your clauses" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clauses" /></div>
          <Button variant="primary" onClick={() => setEdit({ title: "", body: "", tags: "" })}>New clause</Button></div>
        {err && !list ? <ErrorState title="Your clauses did not load" line={plainError(err)} onRetry={load} />
          : !list ? <Loading rows={3} />
          : !list.length ? <EmptyState title={q ? "No clauses match" : "No clauses yet"} line="Save clauses you reuse: limitation of liability, confidentiality, payment terms." />
          : <div className="pk-list">
          {list.map((c) => (
            <div key={c.id} className="pk-item is-static">
              <button type="button" className="pk-item-main ag-grow" onClick={() => setEdit(c)}>
                <strong>{c.title}</strong> <span className="ag-meta">{c.tags}</span></button>
              <span className="ag-meta">used {c.uses}×</span>
              <IconButton size="sm" label="Copy clause" onClick={() => act(async () => { await api(`/packs/legal/clauses/${c.id}/use`, { method: "POST" }); await copy(c.body); toast.ok("Copied"); })}><Copy size={14} /></IconButton>
              <IconButton size="sm" label="Delete clause" onClick={() => act(() => api(`/packs/legal/clauses/${c.id}`, { method: "DELETE" }))}><Trash2 size={14} /></IconButton>
            </div>
          ))}
        </div>}
      </Card>
      {edit && <Card className="pk-stack">
        <Input aria-label="Title" placeholder="Title" value={edit.title ?? ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
        <Textarea aria-label="Clause text" rows={10} placeholder="Clause text" value={edit.body ?? ""} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
        <Input aria-label="Tags" placeholder="Tags, comma separated" value={edit.tags ?? ""} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} />
        <div className="ag-bar"><Button variant="primary" onClick={async () => {
          try { await api(edit.id ? `/packs/legal/clauses/${edit.id}` : "/packs/legal/clauses", { method: edit.id ? "PUT" : "POST", body: edit }); setEdit(null); load(); toast.ok("Saved"); } catch (e) { toast.err(e); }
        }}>Save</Button><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></div>
      </Card>}
    </div>
  );
}
