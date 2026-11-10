import { ArrowLeft, Code2, Download, FileSearch, FileText, FolderOpen, ImagePlus, MessageSquare, Trash2, Upload } from "lucide-react";
import { DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { SurfaceNote } from "../SurfaceNote";
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Section, Select, Tabs, Textarea } from "../ui";
import { Markdown, relTime, useToast } from "../util";
import { Busy, Notice, plainError, Split } from "./day/parts";

type WorkFile = { id: number; name: string; kind: string; size: number; summary: string; source: string; notes: string[]; created_at: string };
type Chunk = { loc: string; text: string };
type Table = { name: string; loc?: string; columns: string[]; rows: unknown[][] | Record<string, unknown>[]; n_rows?: number };
type Detail = WorkFile & { extract: { chunks: Chunk[]; tables: Table[]; meta: Record<string, unknown>; notes: string[] };
  inside: { name: string; kind: string; summary: string; notes: string[] }[] };
type Column = { column: string; type: string; filled: number; missing: number; sum?: number; mean?: number; min?: number; max?: number;
  earliest?: string; latest?: string; most_common?: Record<string, number> };
type Analysis = { file: string; sheets: { sheet: string; rows: number; columns: number; duplicate_rows: number; note?: string;
  column_summary: Column[]; formulas?: { count?: number }; chart?: { title: string; file: number } | null }[] };
type Change = { change: string; where_before: string; where_after: string; redline: string };
type Comparison = { a: string; b: string; summary: string; similarity_percent: number; text_changes: Change[];
  cell_changes: { table: string; cell?: string; column?: string; before?: unknown; after?: unknown; change?: string }[]; report?: { download: string } };
type RunResult = { status: string; isolation: string; stdout: string; error: string; outputs: { id: number; name: string; url: string }[] };
type Helpers = { missing: { key: string; label: string; why: string }[]; can_install: boolean; hint: string; installing: boolean; log: string[]; error: string };
type Caps = { readers: Record<string, boolean>; apps: Record<string, boolean>; helpers?: Helpers };

/** Plain words about missing helper apps, and one Install button (quiet brew / winget install; failures are skipped). */
function HelperApps({ initial }: { initial?: Helpers }) {
  const [h, setH] = useState<Helpers | undefined>(initial);
  useEffect(() => setH(initial), [initial]);
  useEffect(() => {
    if (!h?.installing) return;
    const t = window.setInterval(() => api<Helpers>("/files/helpers").then(setH).catch(() => undefined), 2000);
    return () => window.clearInterval(t);
  }, [h?.installing]);
  if (!h || (h.missing.length === 0 && h.log.length === 0)) return null;
  const install = () => api<Helpers>("/files/helpers/install", { method: "POST" }).then(setH).catch(() => undefined);
  return (
    <Notice className="day-gap"
      title={h.missing.length > 0 ? `${h.missing.length === 1 ? "One free helper app is" : "Some free helper apps are"} not installed yet, so a few files are read with less detail` : "All helper apps are installed."}
      actions={h.missing.length > 0 ? <Button size="sm" variant="primary" busy={h.installing} onClick={install}>{h.installing ? "Installing…" : "Install"}</Button> : undefined}>
      {h.missing.length > 0 && <p>{h.missing.map((m, i) => <span key={m.key}>{i > 0 && ", "}<b>{m.label}</b> ({m.why})</span>)}.</p>}
      {h.log.length > 0 && <p>{h.log.join(" ")}</p>}
      {h.error && <p>{h.error}</p>}
    </Notice>
  );
}

const KB = (n: number) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmt = (v: unknown) => (typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v ?? ""));

async function upload(file: File, name: string): Promise<WorkFile> {
  const res = await fetch(`/api/files/upload?name=${encodeURIComponent(name)}`, {
    method: "POST", credentials: "same-origin", headers: { "X-Workbench": "1", "Content-Type": "application/octet-stream" }, body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `Could not add ${name}`);
  return body;
}

/** Walks a dropped folder (Chrome, Edge, Safari, Firefox) into files with their folder path. */
async function dropped(e: DragEvent): Promise<{ file: File; name: string }[]> {
  const out: { file: File; name: string }[] = [];
  const items = Array.from(e.dataTransfer.items || []);
  const entries = items.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return Array.from(e.dataTransfer.files).map((f) => ({ file: f, name: f.name }));
  const walk = async (en: FileSystemEntry, path: string): Promise<void> => {
    if (en.isFile) {
      const f = await new Promise<File>((ok, bad) => (en as FileSystemFileEntry).file(ok, bad));
      out.push({ file: f, name: path + f.name });
    } else if (en.isDirectory) {
      const reader = (en as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[] = [];
      do {
        batch = await new Promise<FileSystemEntry[]>((ok, bad) => reader.readEntries(ok, bad));
        for (const c of batch) await walk(c, `${path}${en.name}/`);
      } while (batch.length);
    }
  };
  for (const en of entries) await walk(en, "");
  return out;
}

// Phase 4: images from the user's connected provider (OpenAI, Gemini, xAI, OpenRouter), saved here as files.
function MakeImage({ onMade, onError }: { onMade: (fileId: number) => void; onError: (e: unknown) => void }) {
  const [providers, setProviders] = useState<{ connection_id: number; name: string; model: string }[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("square");
  const [conn, setConn] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ providers: { connection_id: number; name: string; model: string }[] }>("/media/images/providers").then((r) => setProviders(r.providers)).catch(() => setProviders([])); }, []);
  if (!providers || !providers.length) return null;
  const make = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ file_id: number }>("/media/images", { body: { prompt, size, connection_id: conn || null } });
      setPrompt("");
      onMade(r.file_id);
    } catch (e) { onError(e); }
    setBusy(false);
  };
  return (
    <Card padding="sm" className="day-gap">
      <form className="day-add-row" onSubmit={(e) => { e.preventDefault(); void make(); }}>
        <ImagePlus size={16} aria-hidden="true" className="day-muted-icon" />
        <Input className="day-grow" aria-label="Describe an image to create" placeholder="Describe an image to create (uses your image provider; usually costs a few cents)"
          value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={4000} />
        <Select className="day-auto" value={size} onChange={(e) => setSize(e.target.value)} aria-label="Shape">
          <option value="square">Square</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option>
        </Select>
        {providers.length > 1 && (
          <Select className="day-auto" value={conn} onChange={(e) => setConn(e.target.value ? Number(e.target.value) : "")} aria-label="Provider">
            <option value="">{providers[0].name} · {providers[0].model}</option>
            {providers.slice(1).map((p) => <option key={p.connection_id} value={p.connection_id}>{p.name} · {p.model}</option>)}
          </Select>
        )}
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!prompt.trim()}>{busy ? "Creating…" : "Create image"}</Button>
      </form>
    </Card>
  );
}

export default function Files() {
  const [list, setList] = useState<WorkFile[] | null>(null);
  const [problem, setProblem] = useState("");
  const [sel, setSel] = useState<Detail | null>(null);
  const [busy, setBusy] = useState("");
  const [over, setOver] = useState(false);
  const [tab, setTab] = useState<"read" | "numbers" | "compare" | "python">("read");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [cmpWith, setCmpWith] = useState<number>(0);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [code, setCode] = useState("df = pd.read_csv('inputs/' + INPUTS[0]) if INPUTS else None\nprint(df.describe() if df is not None else 'Add a file first')");
  const [run, setRun] = useState<RunResult | null>(null);
  const [caps, setCaps] = useState<Caps | null>(null);
  const toast = useToast();
  const pick = useRef<HTMLInputElement>(null);
  const pickDir = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const load = useCallback(() => {
    setProblem("");
    return api<WorkFile[]>("/files").then(setList).catch((e) => { setList((l) => l ?? []); setProblem(plainError(e, "Your files did not load.")); });
  }, []);
  useEffect(() => { void load(); api<Caps>("/files/capabilities").then(setCaps).catch(() => undefined); }, [load]);

  const open = async (id: number) => {
    setBusy("open"); setAnalysis(null); setCmp(null); setRun(null); setTab("read");
    try { setSel(await api<Detail>(`/files/${id}`)); } catch (e) { toast.err(e); } finally { setBusy(""); }
  };

  const addAll = async (items: { file: File; name: string }[]) => {
    if (!items.length) return;
    let last: WorkFile | null = null;
    for (let i = 0; i < items.length; i++) {
      setBusy(`Reading ${items[i].name} (${i + 1} of ${items.length})`);
      try { last = await upload(items[i].file, items[i].name); } catch (e) { toast.err(e); }
    }
    setBusy("");
    await load();
    if (last) { toast.ok(items.length > 1 ? `${items.length} files added` : `${last.name} added`); void open(last.id); }
  };

  const onDrop = async (e: DragEvent) => { e.preventDefault(); setOver(false); void addAll(await dropped(e)); };

  const doAnalyse = async () => {
    if (!sel) return;
    setTab("numbers"); setBusy("Working out the numbers…");
    try { setAnalysis(await api<Analysis>(`/files/${sel.id}/analyse`)); } catch (e) { toast.err(e); } finally { setBusy(""); }
  };
  const doCompare = async (report = false) => {
    if (!sel || !cmpWith) return;
    setBusy("Comparing…");
    try { setCmp(await api<Comparison>("/files/compare", { body: { a: cmpWith, b: sel.id, report } })); } catch (e) { toast.err(e); } finally { setBusy(""); }
  };
  const doRun = async () => {
    setBusy("Running…");
    try { setRun(await api<RunResult>("/files/run", { body: { code: `INPUTS = ${JSON.stringify(sel ? [sel.name.split("/").pop()] : [])}\n${code}`, file_ids: sel ? [sel.id] : [] } })); }
    catch (e) { toast.err(e); } finally { setBusy(""); }
  };
  const doReport = async (format: "docx" | "pdf") => {
    if (!sel) return;
    const body = `**${sel.name}**\n\n${sel.summary}\n\n${sel.extract.chunks.slice(0, 40).map((c) => `*${c.loc}*: ${c.text}`).join("\n\n")}`;
    try { const r = await api<{ download: string }>("/files/report", { body: { title: `Summary of ${sel.name}`, body, format } }); window.open(r.download, "_blank"); }
    catch (e) { toast.err(e); }
  };
  const remove = async (id: number) => {
    await api(`/files/${id}`, { method: "DELETE" }).catch(toast.err);
    if (sel?.id === id) setSel(null);
    void load();
  };
  const ask = () => sel && navigate("/assistant", { state: { draft: `About my file “${sel.name}” (file ${sel.id}): ` } });
  const missing = caps ? [...Object.entries(caps.readers).filter(([, v]) => !v).map(([k]) => k), ...Object.entries(caps.apps).filter(([k, v]) => !v && !/^(LibreOffice|Tesseract|FFmpeg)/.test(k)).map(([k]) => k)] : [];
  const choose = () => pick.current?.click();
  const pickTab = (t: string) => {
    if (t === "numbers") { if (sel?.extract.tables.length) void doAnalyse(); return; }
    setTab(t as typeof tab);
  };

  const listPane = (
    <div className="day-split-scroll">
      {list === null && <Loading rows={6} label="Loading files" />}
      {list !== null && problem && <div className="day-pad"><ErrorState title="Files did not load" line={problem} onRetry={() => void load()} /></div>}
      {list !== null && !problem && list.length === 0 && (
        <EmptyState icon={<FileText size={22} />} title="No files yet" line="Anything you drop in shows here." action={<Button size="sm" icon={<Upload size={14} />} onClick={choose}>Choose files</Button>} />
      )}
      {list !== null && list.length > 0 && (
        <List label="Files">
          {list.map((f) => (
            <Row key={f.id} active={sel?.id === f.id} onClick={() => void open(f.id)} title={f.name}
              meta={`${f.kind} · ${KB(f.size)} · ${f.source.startsWith("site:") ? "from a site" : relTime(f.created_at)}`}
              actions={<IconButton label={`Remove ${f.name}`} size="sm" onClick={() => void remove(f.id)}><Trash2 size={14} /></IconButton>} />
          ))}
        </List>
      )}
    </div>
  );

  const mainPane = !sel ? (
    busy === "open" ? <div className="day-pad"><Loading rows={4} label="Opening the file" /></div>
      : <EmptyState icon={<FileSearch size={24} />} title="Pick a file to see what is inside" line="Then ask about it in Chat, check the numbers, compare versions or run a calculation." />
  ) : (
    <div className="day-detail">
      <header className="day-detail-head">
        <IconButton className="day-phone-only" label="Back to the list" size="sm" onClick={() => setSel(null)}><ArrowLeft size={16} /></IconButton>
        <div className="day-detail-titles">
          <h2 className="day-detail-title">{sel.name}</h2>
          {sel.summary && <p className="day-detail-meta">{sel.summary}</p>}
        </div>
        <div className="day-actions">
          <Button variant="primary" size="sm" icon={<MessageSquare size={14} />} onClick={ask}>Ask about it</Button>
          <a className="ui-btn ui-btn-secondary ui-btn-sm" href={`/api/files/${sel.id}/download`}><Download size={14} aria-hidden="true" /> Original</a>
        </div>
      </header>
      {[...sel.notes, ...sel.extract.notes].filter((n, i, a) => a.indexOf(n) === i).map((n) => <Notice key={n} tone="warn">{n}</Notice>)}
      <div className="day-tabs-row">
        <Tabs label="What to do with this file" value={tab} onChange={pickTab}
          items={[{ id: "read", label: "What it says" }, ...(sel.extract.tables.length ? [{ id: "numbers", label: "Numbers" }] : []), { id: "compare", label: "Compare" }, { id: "python", label: "Calculate" }]} />
      </div>

      {tab === "read" && (
        <div className="day-stack">
          <div className="day-actions"><Button size="sm" onClick={() => void doReport("docx")}>Word summary</Button><Button size="sm" onClick={() => void doReport("pdf")}>PDF summary</Button></div>
          {sel.inside.length > 0 && (
            <Section title="Inside">
              <List label="Inside">{sel.inside.map((x, i) => <Row key={i} title={x.name} meta={x.summary} />)}</List>
            </Section>
          )}
          {sel.extract.tables.slice(0, 3).map((t, i) => <TableView key={i} t={t} />)}
          <div className="day-passages">
            {sel.extract.chunks.slice(0, 120).map((c, i) => <div key={i} className="day-passage"><Badge>{c.loc}</Badge><Markdown text={c.text.slice(0, 3000)} /></div>)}
          </div>
        </div>
      )}

      {tab === "numbers" && !analysis && <Loading rows={3} label="Working out the numbers" />}
      {tab === "numbers" && analysis && analysis.sheets.map((sh) => (
        <Section key={sh.sheet} title={sh.sheet}
          description={`${sh.rows.toLocaleString()} rows · ${sh.columns} columns${sh.duplicate_rows ? ` · ${sh.duplicate_rows} duplicate rows` : ""}${sh.formulas?.count ? ` · ${sh.formulas.count} formulas` : ""}${sh.note ? `. ${sh.note}` : ""}`}>
          {sh.chart && <img className="day-chart" src={`/api/files/${sh.chart.file}/download`} alt={sh.chart.title} />}
          <div className="day-table-wrap"><table className="day-table"><thead><tr><th>Column</th><th>Type</th><th>Filled</th><th>Total</th><th>Average</th><th>Lowest</th><th>Highest</th><th>Most common</th></tr></thead>
            <tbody>{sh.column_summary.map((c) => <tr key={c.column}><td>{c.column}</td><td>{c.type}</td><td>{c.filled}{c.missing ? ` (${c.missing} empty)` : ""}</td><td>{fmt(c.sum)}</td><td>{fmt(c.mean)}</td>
              <td>{fmt(c.min ?? c.earliest)}</td><td>{fmt(c.max ?? c.latest)}</td><td>{c.most_common ? Object.keys(c.most_common).slice(0, 3).join(", ") : ""}</td></tr>)}</tbody></table></div>
        </Section>
      ))}

      {tab === "compare" && (
        <div className="day-stack">
          <div className="day-add-row">
            <Select label="Compare an older version with this one" className="day-grow" value={cmpWith} onChange={(e) => setCmpWith(Number(e.target.value))}>
              <option value={0}>Choose a file…</option>
              {(list ?? []).filter((f) => f.id !== sel.id).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </div>
          <div className="day-actions">
            <Button variant="primary" size="sm" disabled={!cmpWith} onClick={() => void doCompare(false)}>Show changes</Button>
            <Button size="sm" disabled={!cmpWith} onClick={() => void doCompare(true)}>Word redline</Button>
          </div>
          {cmp && <>
            <p className="day-hint">{cmp.summary}</p>
            {cmp.report && <a className="ui-btn ui-btn-secondary ui-btn-sm day-self-start" href={cmp.report.download}><Download size={14} aria-hidden="true" /> Download the redline</a>}
            {cmp.text_changes.map((c, i) => <div key={i} className="day-passage"><Badge>{c.where_after || c.where_before}</Badge> <span className="day-hint">{c.change}</span>
              <div className="redline day-redline" dangerouslySetInnerHTML={{ __html: c.redline }} /></div>)}
            {cmp.cell_changes.slice(0, 100).map((c, i) => <p key={i} className="day-cell-change">{c.table} {c.cell || c.change}: <del>{fmt(c.before)}</del> → <ins>{fmt(c.after)}</ins></p>)}
          </>}
        </div>
      )}

      {tab === "python" && (
        <div className="day-stack">
          <p className="day-hint">Runs on this computer with pandas, numpy, matplotlib and sympy, without internet. This file is in <code>inputs/</code>; charts appear below.</p>
          <Textarea className="day-mono" rows={8} value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} aria-label="Calculation" />
          <div className="day-actions"><Button variant="primary" size="sm" icon={<Code2 size={14} />} onClick={() => void doRun()}>Run</Button>{run && <span className="day-hint">{run.isolation}</span>}</div>
          {run && <>
            {run.stdout && <pre className="day-out">{run.stdout}</pre>}
            {run.error && <Notice tone="danger" title="The calculation stopped"><pre className="day-out">{run.error.split("\n").slice(-6).join("\n")}</pre></Notice>}
            {run.outputs.map((o) => /\.(png|jpe?g|svg)$/i.test(o.name) ? <img key={o.id} className="day-chart" src={o.url} alt={o.name} /> : <a key={o.id} className="ui-btn ui-btn-secondary ui-btn-sm day-self-start" href={o.url}><Download size={14} aria-hidden="true" /> {o.name}</a>)}
          </>}
        </div>
      )}
    </div>
  );

  return (
    <Page title="Files" wide className="day-page"
      description="Drop in anything: spreadsheets, Word, PDFs, slides, emails, zips, photos, data or code. It is read on this computer; only the text you ask about goes to your model."
      actions={<Button variant="primary" icon={<Upload size={15} />} onClick={choose}>Add files</Button>}>
      <SurfaceNote />
      <HelperApps initial={caps?.helpers} />
      <MakeImage onMade={(id) => { void load(); void open(id); }} onError={toast.err} />
      <div className={`day-drop${over ? " is-over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        onClick={choose} role="button" tabIndex={0} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), choose())}>
        <Upload size={20} aria-hidden="true" className="day-muted-icon" />
        <div className="day-drop-text"><strong>Drop files or a folder here</strong><span className="day-hint">or click to choose files</span></div>
        <Button size="sm" icon={<FolderOpen size={14} />} onClick={(e) => { e.stopPropagation(); pickDir.current?.click(); }}>Choose a folder</Button>
        <input ref={pick} type="file" multiple hidden onChange={(e) => void addAll(Array.from(e.target.files || []).map((f) => ({ file: f, name: f.name })))} />
        <input ref={pickDir} type="file" multiple hidden {...{ webkitdirectory: "" }} onChange={(e) => void addAll(Array.from(e.target.files || []).map((f) => ({ file: f, name: f.webkitRelativePath || f.name })))} />
      </div>
      {busy && busy !== "open" && <Busy>{busy}</Busy>}
      {list !== null && !problem && list.length === 0 && !sel
        ? <EmptyState icon={<FileText size={24} />} title="No files yet" line="Anything you drop in shows here." action={<Button icon={<Upload size={14} />} onClick={choose}>Choose files</Button>} />
        : <Split label="Files" picked={!!sel} list={listPane} main={mainPane} />}
      {missing.length > 0 && <p className="day-hint day-caps">Not installed on this computer, so some files are read with less detail: {missing.join(", ")}.</p>}
    </Page>
  );
}

function TableView({ t }: { t: Table }) {
  const rows = (t.rows as unknown[]).slice(0, 25).map((r) => (Array.isArray(r) ? r : t.columns.map((c) => (r as Record<string, unknown>)[c])));
  return (
    <Section title={t.name} description={t.n_rows ? `${t.n_rows.toLocaleString()} rows` : undefined}>
      <div className="day-table-wrap"><table className="day-table"><thead><tr>{t.columns.slice(0, 20).map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{(r as unknown[]).slice(0, 20).map((v, j) => <td key={j}>{fmt(v)}</td>)}</tr>)}</tbody></table></div>
    </Section>
  );
}
