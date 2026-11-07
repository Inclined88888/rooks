// Study & research pack: flashcards with spaced repetition, worked maths checked by sympy, references, lab notebook (feat/v02-packs).
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, X } from "lucide-react";
import { ApiError, api } from "../api";
import { GRADES, authorsText, deckProgress, gradeForKey, mathBlock, parseAuthors, workingLines } from "../packs/logic";
import { FilePick, PackGate, download, useFiles } from "../packs/shared";
import { Markdown, useToast } from "../util";
import { Badge, Button, Card as Panel, EmptyState, ErrorState, Input, Loading, Page, Select, Tabs, Textarea } from "../ui";
import { plainError } from "./agents/kit";
import "../packs/packs.css";

type Card = { id: number; deck: string; front: string; back: string; source: string; reps: number };
type Deck = { deck: string; cards: number; due: number };
type Tab = "cards" | "maths" | "refs" | "lab";
type Toast = ReturnType<typeof useToast>;

export default function PackStudy() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "cards";
  const [gate, setGate] = useState<unknown>(null);
  const [err, setErr] = useState<unknown>(null);
  const [ready, setReady] = useState(false);
  const toast = useToast();
  const check = useCallback(() => {
    setErr(null);
    api("/packs/study/decks").then(() => setReady(true))
      .catch((e) => (e instanceof ApiError && (e.status === 402 || e.status === 409) ? setGate(e) : setErr(e)));
  }, []);
  useEffect(check, [check]);
  const head = { kicker: "Study and research pack", title: "Study", description: "Learn it, work it out, cite it and write it up." };
  if (gate) return <Page className="ag-page" {...head}><PackGate error={gate} packId="study" name="Study & research pack" /></Page>;
  if (err) return <Page className="ag-page" {...head}><ErrorState title="The Study pack did not open" line={plainError(err)} onRetry={check} /></Page>;
  if (!ready) return <Page className="ag-page" {...head}><Loading rows={4} /></Page>;
  const tabs: [Tab, string][] = [["cards", "Flashcards"], ["maths", "Maths"], ["refs", "References"], ["lab", "Lab notebook"]];
  return (
    <Page wide className="ag-page pk-page" {...head}
      actions={<Tabs label="Study pack" value={tab} onChange={(k) => setParams({ tab: k })} items={tabs.map(([id, label]) => ({ id, label }))} />}>
      {tab === "cards" && <Flashcards toast={toast} />}
      {tab === "maths" && <Maths toast={toast} />}
      {tab === "refs" && <Refs toast={toast} />}
      {tab === "lab" && <Lab toast={toast} />}
    </Page>
  );
}

function Flashcards({ toast }: { toast: Toast }) {
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [deckErr, setDeckErr] = useState<unknown>(null);
  const [queue, setQueue] = useState<Card[] | null>(null);
  const [showBack, setShowBack] = useState(false);
  const [file, setFile] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [deck, setDeck] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState("");
  const files = useFiles();
  const load = useCallback(() => api<Deck[]>("/packs/study/decks").then((d) => { setDecks(d); setDeckErr(null); }).catch(setDeckErr), []);
  useEffect(() => { load(); }, [load]);
  const card = queue?.[0];
  const grade = useCallback(async (g: string) => {
    if (!card) return;
    try {
      const r = await api<{ next_in: string }>(`/packs/study/cards/${card.id}/review`, { body: { grade: g } });
      setLast(`Back in ${r.next_in}`);
      setQueue((q) => (q ? [...q.slice(1), ...(g === "again" ? [card] : [])] : q));
      setShowBack(false);
    } catch (e) { toast.err(e); }
  }, [card]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!card) return;
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (e.key === " ") { e.preventDefault(); setShowBack((f) => !f); return; }
      const g = gradeForKey(e.key);
      if (g && showBack) grade(g);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [card, showBack, grade]);

  if (queue) {
    return (
      <div className="pk-stack">
        <div className="ag-bar"><Button variant="ghost" onClick={() => { setQueue(null); load(); }}>Back to decks</Button>
          <span className="ag-meta">{queue.length} to go{last ? ` · ${last}` : ""}</span></div>
        {card ? <>
          {/* The answer replaces the question at once: no flip, no turn. */}
          <button type="button" className="pk-card" onClick={() => setShowBack(!showBack)} aria-label={showBack ? "Show question" : "Show answer"} aria-live="polite">
            {!showBack
              ? <span className="pk-face"><span className="q">{card.front}</span><span className="ag-meta">Tap or press space to see the answer</span><span className="src">{card.deck}</span></span>
              : <span className="pk-face is-back"><span className="pk-answer"><Markdown text={card.back} /></span><span className="src">{card.source}</span></span>}
          </button>
          {showBack && <div className="pk-grades">{GRADES.map((g) => <button key={g.key} type="button" className="ui-btn ui-btn-secondary pk-grade" onClick={() => grade(g.key)}>{g.label}<small>{g.hint} · {g.shortcut}</small></button>)}</div>}
        </> : <Panel><EmptyState icon={<Check size={20} />} title="All done for now" line="Cards come back when they're due, sooner if you found them hard." /></Panel>}
      </div>
    );
  }
  return (
    <div className="pk-two">
      <Panel className="pk-stack">
        <h2 className="ag-h3">Your decks</h2>
        {deckErr && !decks ? <ErrorState title="Your decks did not load" line={plainError(deckErr)} onRetry={load} />
          : !decks ? <Loading rows={3} />
          : !decks.length ? <EmptyState title="No decks yet" line="Make cards from a file or your notes." /> : (
          <div className="pk-list">{decks.map((d) => (
            <div key={d.deck} className="pk-item is-static">
              <span className="ag-grow"><strong>{d.deck}</strong> <span className="ag-meta">{deckProgress(d.cards, d.due)}</span></span>
              <Button size="sm" variant="primary" disabled={!d.due} onClick={async () => { try { setQueue(await api<Card[]>(`/packs/study/due?deck=${encodeURIComponent(d.deck)}`)); setShowBack(false); } catch (e) { toast.err(e); } }}>Review</Button>
            </div>))}</div>
        )}
      </Panel>
      <Panel className="pk-stack">
        <h2 className="ag-h3">Make flashcards</h2>
        <FilePick label="From a file (notes, slides, PDF…)" value={file} onChange={setFile} files={files.files} onAdded={files.reload} />
        <Textarea aria-label="Notes" rows={5} placeholder="…or paste notes" value={text} onChange={(e) => setText(e.target.value)} disabled={!!file} />
        <Input aria-label="Deck name" placeholder="Deck name (optional)" value={deck} onChange={(e) => setDeck(e.target.value)} />
        <div className="ag-bar"><Button variant="primary" busy={busy} disabled={!file && !text.trim()} onClick={async () => {
          setBusy(true);
          try { const r = await api<{ made: number; deck: string; note: string }>("/packs/study/cards", { body: { file_id: file, text, deck } }); toast.ok(r.made ? `${r.made} cards in ${r.deck}` : r.note); setText(""); load(); }
          catch (e) { toast.err(e); }
          setBusy(false);
        }}>{busy ? "Making…" : "Make cards"}</Button></div>
      </Panel>
    </div>
  );
}

type MathRes = { task: string; steps: { say: string; latex: string }[]; answer_latex: string; check: { ok: boolean; how: string } | null };
type StepRes = { lines: { line: number; latex: string; ok: boolean; why: string }[]; first_wrong: number | null; all_ok: boolean };
const TASKS = ["auto", "solve", "simplify", "factor", "expand", "differentiate", "integrate", "limit", "evaluate"];

function Maths({ toast }: { toast: Toast }) {
  const [expr, setExpr] = useState("");
  const [task, setTask] = useState("auto");
  const [v, setV] = useState("");
  const [to, setTo] = useState("");
  const [r, setR] = useState<MathRes | null>(null);
  const [work, setWork] = useState("");
  const [chk, setChk] = useState<StepRes | null>(null);
  const [busy, setBusy] = useState("");
  return (
    <div className="pk-two">
      <Panel className="pk-stack">
        <h2 className="ag-h3">Work it out</h2>
        <Input className="ag-mono" placeholder="For example x^2 - 5x + 6 = 0, or \frac{1}{x} + x^3" value={expr} onChange={(e) => setExpr(e.target.value)} aria-label="Maths" />
        <div className="ag-bar">
          <Select className="pk-auto" value={task} onChange={(e) => setTask(e.target.value)} aria-label="What to do">{TASKS.map((t) => <option key={t} value={t}>{t === "auto" ? "Work out what to do" : t[0].toUpperCase() + t.slice(1)}</option>)}</Select>
          <div className="pk-narrow"><Input placeholder="variable" value={v} onChange={(e) => setV(e.target.value)} aria-label="Variable" /></div>
          {task === "limit" && <div className="pk-narrow"><Input placeholder="towards" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Limit point" /></div>}
          <Button variant="primary" busy={busy === "m"} disabled={!expr.trim() || (!!busy && busy !== "m")} onClick={async () => { setBusy("m"); try { setR(await api<MathRes>("/packs/study/maths", { body: { expression: expr, task, variable: v, to } })); } catch (e) { toast.err(e); } setBusy(""); }}>{busy === "m" ? "Working…" : "Show steps"}</Button>
        </div>
        {r && <div>
          {r.steps.map((s, i) => <div key={i} className="pk-step"><span className="n">{i + 1}</span><div><p className="ag-label">{s.say}</p><Markdown text={mathBlock(s.latex)} /></div></div>)}
          {r.check && <p className={`pk-check ${r.check.ok ? "ok" : "bad"}`}>{r.check.ok ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />} {r.check.ok ? "Checked" : "Check failed"}: {r.check.how}</p>}
        </div>}
      </Panel>
      <Panel className="pk-stack">
        <h2 className="ag-h3">Check my working</h2>
        <Textarea aria-label="Your working" className="ag-mono" rows={6} placeholder={"One step per line:\n2x + 4 = 10\n2x = 6\nx = 3"} value={work} onChange={(e) => setWork(e.target.value)} />
        <div className="ag-bar"><Button busy={busy === "c"} disabled={workingLines(work).length < 2 || (!!busy && busy !== "c")} onClick={async () => { setBusy("c"); try { setChk(await api<StepRes>("/packs/study/maths/check", { body: { lines: workingLines(work) } })); } catch (e) { toast.err(e); } setBusy(""); }}>{busy === "c" ? "Checking…" : "Check each step"}</Button></div>
        {chk && <div>
          <p className={`pk-check ${chk.all_ok ? "ok" : "bad"}`}>{chk.all_ok ? "Every step follows from the one before." : `Step ${chk.first_wrong} is where it goes wrong.`}</p>
          {chk.lines.map((l) => <div key={l.line} className="pk-step"><span className="n">{l.ok ? <Check size={14} aria-label="Follows" /> : <X size={14} aria-label="Does not follow" />}</span><div><Markdown text={mathBlock(l.latex)} />{l.why && <span className={l.ok ? "ag-meta" : "pk-err"}>{l.why}</span>}</div></div>)}
        </div>}
      </Panel>
    </div>
  );
}

type Ref = { id: number; key: string; type: string; title: string; authors: { family: string; given: string }[]; year: string; container: string; doi: string };

function Refs({ toast }: { toast: Toast }) {
  const [list, setList] = useState<Ref[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [doi, setDoi] = useState("");
  const [bib, setBib] = useState("");
  const [form, setForm] = useState({ type: "article", title: "", authors: "", year: "", container: "", volume: "", issue: "", pages: "", url: "", publisher: "" });
  const [zot, setZot] = useState<{ running: boolean; local_api: boolean; how: string } | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(() => api<Ref[]>("/packs/study/refs").then((l) => { setList(l); setErr(null); }).catch(setErr), []);
  useEffect(() => { load(); api<typeof zot>("/packs/study/zotero").then(setZot).catch(() => setZot(null)); }, [load]);
  const run = async (k: string, f: () => Promise<void>) => { setBusy(k); try { await f(); } catch (e) { toast.err(e); } setBusy(""); };
  const refs = list ?? [];
  return (
    <div className="pk-two">
      <Panel className="pk-stack">
        <div className="ag-bar"><h2 className="ag-h3 ag-grow">References · {refs.length}</h2>
          <a className="ui-btn ui-btn-secondary ui-btn-sm" href="/api/packs/study/refs/export?format=bibtex" download="references.bib">BibTeX</a>
          <a className="ui-btn ui-btn-secondary ui-btn-sm" href="/api/packs/study/refs/export?format=ris" download="references.ris">RIS</a></div>
        {err && !list ? <ErrorState title="Your references did not load" line={plainError(err)} onRetry={load} />
          : !list ? <Loading rows={3} />
          : !refs.length ? <EmptyState title="No references yet" line="Add a DOI, type one in, import BibTeX, or bring your Zotero library over." />
          : <div className="pk-list">{refs.map((r) => (
          <div key={r.id} className="pk-find">
            <span>{authorsText(r.authors)} ({r.year || "n.d."}) <em>{r.title}</em>{r.container ? `, ${r.container}` : ""}</span>
            <span className="where">{r.key}{r.doi ? ` · doi ${r.doi}` : ""} · <button type="button" className="pk-link" onClick={() => run("d", async () => { await api(`/packs/study/refs/${r.id}`, { method: "DELETE" }); load(); })}>Remove</button></span>
          </div>))}</div>}
        <div className="pk-draft">
          <div className="ag-bar"><strong>Zotero</strong><Badge tone={zot?.running ? "ok" : "neutral"}>{zot?.running ? (zot.local_api ? "Open" : "Open · library sharing off") : "Not open"}</Badge></div>
          {(!zot?.running || !zot?.local_api) && <p className="ag-meta">{zot?.how ?? "Open Zotero on this computer."}</p>}
          <div className="ag-bar">
            <Button size="sm" disabled={!zot?.local_api || !!busy} onClick={() => run("zi", async () => { const r = await api<{ added: number }>("/packs/study/zotero/import", { method: "POST" }); toast.ok(`${r.added} added from Zotero`); load(); })}>Bring in from Zotero</Button>
            <Button size="sm" disabled={!zot?.running || !refs.length || !!busy} onClick={() => run("zs", async () => { const r = await api<{ sent: number }>("/packs/study/zotero/send", { body: { ids: [] } }); toast.ok(`${r.sent} sent to Zotero`); })}>Send all to Zotero</Button>
            <Button size="sm" variant="ghost" onClick={() => api<typeof zot>("/packs/study/zotero").then(setZot).catch(() => setZot(null))}>Check again</Button>
          </div>
        </div>
      </Panel>
      <Panel className="pk-stack">
        <h2 className="ag-h3">Add</h2>
        <div className="ag-bar"><div className="ag-grow"><Input className="ag-mono" aria-label="DOI" placeholder="DOI, for example 10.1038/nature14539" value={doi} onChange={(e) => setDoi(e.target.value)} /></div>
          <Button variant="primary" busy={busy === "doi"} disabled={!doi.trim() || (!!busy && busy !== "doi")} onClick={() => run("doi", async () => { await api("/packs/study/refs/doi", { body: { doi } }); setDoi(""); load(); toast.ok("Added"); })}>{busy === "doi" ? "Looking up…" : "Look up"}</Button></div>
        <details className="ag-advanced"><summary>Type one in</summary>
          <div className="pk-stack ag-gap-top">
            <Select aria-label="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{["article", "book", "chapter", "conference", "report", "thesis", "web", "dataset", "other"].map((t) => <option key={t}>{t}</option>)}</Select>
            {(["title", "authors", "year", "container", "volume", "issue", "pages", "publisher", "url"] as const).map((k) => {
              const ph = k === "authors" ? "Authors (Family, Given; …)" : k === "container" ? "Journal or book" : k === "url" ? "Web address" : k[0].toUpperCase() + k.slice(1);
              return <Input key={k} aria-label={ph} placeholder={ph} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />;
            })}
            <div className="ag-bar"><Button disabled={!form.title.trim()} onClick={() => run("add", async () => { await api("/packs/study/refs", { body: { ...form, authors: parseAuthors(form.authors) } }); setForm({ ...form, title: "", authors: "", year: "", pages: "" }); load(); })}>Save</Button></div>
          </div></details>
        <details className="ag-advanced"><summary>Import BibTeX</summary>
          <div className="pk-stack ag-gap-top">
            <Textarea aria-label="BibTeX" className="ag-mono" rows={6} value={bib} onChange={(e) => setBib(e.target.value)} placeholder="@article{…}" />
            <div><Button disabled={!bib.trim()} onClick={() => run("bib", async () => { const r = await api<{ added: number }>("/packs/study/refs/import", { body: { bibtex: bib } }); toast.ok(`${r.added} imported`); setBib(""); load(); })}>Import</Button></div>
          </div></details>
      </Panel>
    </div>
  );
}

type Entry = { id: number; title: string; body: string; tags: string; entry_date: string; created_at: string; updated_at: string;
  attachments: { id: number; name: string; missing?: boolean }[]; amendments: { at: string; title: string; body: string }[] };

function Lab({ toast }: { toast: Toast }) {
  const [list, setList] = useState<Entry[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [pro, setPro] = useState("");
  const [edit, setEdit] = useState<Partial<Entry> & { attach?: number[] } | null>(null);
  const [q, setQ] = useState("");
  const files = useFiles();
  const load = useCallback(() => api<Entry[]>(`/packs/study/lab?q=${encodeURIComponent(q)}`).then((x) => { setList(x); setPro(""); setErr(null); })
    .catch((e) => { if (e instanceof ApiError && e.status === 402) setPro(e.message); else setErr(e); }), [q]);
  useEffect(() => { load(); }, [load]);
  if (pro) return <Panel className="pk-gate"><p className="ag-meta">Pro</p><h2 className="ag-title">The lab notebook is part of Pro</h2><p className="ag-note">{pro}</p><p className="ag-note">Flashcards, maths and references stay free.</p></Panel>;
  const exp = async (format: string) => { try { download((await api<{ download: string }>("/packs/study/lab/export", { body: { format } })).download); } catch (e) { toast.err(e); } };
  return (
    <div className="pk-two">
      <Panel className="pk-stack">
        <div className="ag-bar"><div className="ag-grow"><Input placeholder="Search entries" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search entries" /></div>
          <Button variant="primary" onClick={() => setEdit({ title: "", body: "", tags: "", attach: [] })}>New entry</Button></div>
        {err && !list ? <ErrorState title="The notebook did not load" line={plainError(err)} onRetry={load} />
          : !list ? <Loading rows={3} />
          : !list.length ? <EmptyState title={q ? "No entries match" : "No entries yet"} line="Dated entries for experiments, observations and results." />
          : <div className="pk-list">{list.map((e) => (
          <button key={e.id} type="button" className="pk-item" onClick={() => setEdit({ ...e, attach: e.attachments.map((a) => a.id) })}>
            <span className="ag-mono ag-meta">{e.entry_date}</span><span className="ag-grow">{e.title}</span>
            {e.amendments.length > 0 && <Badge>Amended {e.amendments.length}×</Badge>}
            {e.attachments.length > 0 && <span className="ag-meta">{e.attachments.length} file{e.attachments.length > 1 ? "s" : ""}</span>}
          </button>))}</div>}
        <div className="ag-bar"><span className="ag-meta">Export</span>
          {["pdf", "md", "json"].map((f) => <Button key={f} size="sm" disabled={!list?.length} onClick={() => exp(f)}>{f === "md" ? "Markdown" : f.toUpperCase()}</Button>)}</div>
      </Panel>
      {edit && <Panel className="pk-stack">
        {edit.id && <p className="ag-note">Entry for {edit.entry_date}. Changes are kept as amendments, so the original stays on record.</p>}
        <Input aria-label="Title" placeholder="Title" value={edit.title ?? ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
        {!edit.id && <Input type="date" value={edit.entry_date ?? ""} onChange={(e) => setEdit({ ...edit, entry_date: e.target.value })} aria-label="Date (today if blank)" />}
        <Textarea aria-label="Entry" rows={10} placeholder="Method, observations, results… ($maths$ works)" value={edit.body ?? ""} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
        <Input aria-label="Tags" placeholder="Tags" value={edit.tags ?? ""} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} />
        <div className="pk-stack">
          {(edit.attach ?? []).map((id) => <div key={id} className="ag-bar ag-meta">{files.files.find((f) => f.id === id)?.name ?? `File ${id}`}
            <Button size="sm" variant="ghost" onClick={() => setEdit({ ...edit, attach: (edit.attach ?? []).filter((x) => x !== id) })}>Remove</Button></div>)}
          <FilePick label="Attach a file" value={null} onChange={(id) => id && setEdit({ ...edit, attach: [...new Set([...(edit.attach ?? []), id])] })} files={files.files} onAdded={files.reload} />
        </div>
        <div className="ag-bar"><Button variant="primary" disabled={!edit.title?.trim()} onClick={async () => {
          try { await api(edit.id ? `/packs/study/lab/${edit.id}` : "/packs/study/lab", { method: edit.id ? "PUT" : "POST", body: { ...edit, attachments: edit.attach } }); setEdit(null); load(); toast.ok("Saved"); } catch (e) { toast.err(e); }
        }}>Save</Button><Button variant="ghost" onClick={() => setEdit(null)}>Close</Button></div>
        {!!edit.amendments?.length && <details className="ag-advanced"><summary>Earlier versions</summary>
          {edit.amendments.map((a, i) => <div key={i} className="pk-find"><span className="where">{new Date(a.at.endsWith("Z") ? a.at : a.at + "Z").toLocaleString()}</span><Markdown text={a.body} /></div>)}</details>}
      </Panel>}
    </div>
  );
}
