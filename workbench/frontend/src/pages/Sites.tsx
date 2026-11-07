import { ArrowLeft, BellRing, CalendarPlus, Check, Download, ExternalLink, FileDown, Globe, KeyRound, LogIn, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { ApprovalCard, Badge, Button, Card, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Section, Select, Tabs, Textarea } from "../ui";
import { relTime, useToast } from "../util";
import { Busy, Notice, plainError, Split } from "./day/parts";

type Watch = { id: number; request: string; cron: string; in_words?: string; next_run: string | null; last_run: string | null; last_result?: string };
type Form = { name: string; submit: string; page_url: string; fields: { name: string; label: string; type: string; options: { value: string; label: string }[]; value: string }[] };
type Site = { id: number; name: string; url: string; mode: string; recipe: string; status: string; status_detail: string; last_checked: string | null;
  has_key: boolean; records?: number; last_digest?: string; recipe_info: { label?: string; help?: string; kind?: string };
  structure: { collections?: { name: string; entity: string; count: number; roles: Record<string, string> }[]; forms?: Form[]; files?: { url: string; name: string }[];
    navigation?: { text: string; url: string }[] };
  checks?: { id: number; at: string; status: string; digest: string }[]; watches?: Watch[] };
type Rec = { id: number; collection: string; title: string; status: string; start: string; due: string; finish: string; person: string; location: string;
  amount: string; url: string; overdue: boolean; done: boolean };
type Item = { id: number; title: string; start: string; end: string; status: string; overdue: boolean; done: boolean; collection: string };
type Action = { id: number; site_id: number; summary: string; status: string; result: string; created_at: string };

const day = (s: string) => new Date(s.slice(0, 10) + "T00:00:00").getTime();
const short = (s: string) => (s ? new Date(s.length > 10 ? s : s + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }) + (s.length > 10 ? " " + s.slice(11, 16) : "") : "");

const SITE_STATE: Record<string, string> = { ok: "is-ok", needs_sign_in: "is-warn", error: "is-danger" };

export default function Sites() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [problem, setProblem] = useState("");
  const [browser, setBrowser] = useState(false);
  const [sel, setSel] = useState<Site | null>(null);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [tab, setTab] = useState<"overview" | "records" | "schedule" | "do">("overview");
  const [busy, setBusy] = useState("");
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [watchText, setWatchText] = useState("");
  const [key, setKey] = useState("");
  const [coll, setColl] = useState("");
  const [formIdx, setFormIdx] = useState(-1);
  const [vals, setVals] = useState<Record<string, string>>({});
  const toast = useToast();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const r = await api<{ sites: Site[]; browser: boolean }>("/sites");
    setSites(r.sites); setBrowser(r.browser);
    setActions(await api<Action[]>("/site-actions"));
    return r.sites;
  }, []);
  const open = useCallback(async (id: number) => {
    const [s, r, t] = await Promise.all([api<Site>(`/sites/${id}`), api<Rec[]>(`/sites/${id}/records`), api<Item[]>(`/sites/${id}/timeline`)]);
    setSel(s); setRecs(r); setItems(t);
  }, []);
  const first = useCallback(() => {
    setProblem("");
    load().then((s) => { if (s[0] && window.matchMedia?.("(min-width: 901px)").matches) return open(s[0].id); })
      .catch((e) => { setSites((v) => v ?? []); setProblem(plainError(e, "Your sites did not load.")); });
  }, [load, open]);
  useEffect(first, [first]);

  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    try { const r = await fn(); if (ok) toast.ok(ok); await load(); if (sel) await open(sel.id); return r; }
    catch (e) { toast.err(e); } finally { setBusy(""); }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("Adding…");
    try {
      const s = await api<Site>("/sites", { body: { url, name } });
      setAdding(false); setUrl(""); setName("");
      await load(); await open(s.id);
      if (!s.recipe_info?.kind || s.recipe_info.kind === "browser") {
        setBusy("Reading the site for the first time…");
        await api(`/sites/${s.id}/check`, { method: "POST" }).catch(() => undefined);
        await load(); await open(s.id);
      }
    } catch (err) { toast.err(err); } finally { setBusy(""); }
  };

  const collections = sel?.structure.collections ?? [];
  const forms = sel?.structure.forms ?? [];
  const shown = coll ? recs.filter((r) => r.collection === coll) : recs;
  const overdue = recs.filter((r) => r.overdue);
  const pending = actions.filter((a) => a.status === "pending" && a.site_id === sel?.id);
  const form = formIdx >= 0 ? forms[formIdx] : null;
  const siteLine = (s: Site) => (s.status === "needs_sign_in" ? "Needs you to sign in" : s.status === "error" ? "Could not read" : s.last_checked ? `${s.records ?? 0} items · checked ${relTime(s.last_checked)}` : "Not read yet");

  const listPane = (
    <div className="day-split-scroll">
      {sites === null && <Loading rows={4} label="Loading sites" />}
      {sites !== null && problem && <div className="day-pad"><ErrorState title="Sites did not load" line={problem} onRetry={first} /></div>}
      {sites !== null && !problem && sites.length === 0 && (
        <EmptyState icon={<Globe size={22} />} title="No sites yet" line="Add the address of a site you use for work." action={<Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add a site</Button>} />
      )}
      {sites !== null && sites.length > 0 && (
        <List label="Sites">
          {sites.map((s) => (
            <Row key={s.id} active={sel?.id === s.id} onClick={() => { setTab("overview"); setColl(""); void open(s.id); }} title={s.name} meta={siteLine(s)}
              leading={<span className={`day-dot ${SITE_STATE[s.status] ?? ""}`} />} />
          ))}
        </List>
      )}
    </div>
  );

  const mainPane = !sel ? (
    <EmptyState icon={<Globe size={24} />} title="Pick a site, or add one" action={<Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add a site</Button>} />
  ) : (
    <div className="day-detail">
      <header className="day-detail-head">
        <IconButton className="day-phone-only" label="Back to the list" size="sm" onClick={() => setSel(null)}><ArrowLeft size={16} /></IconButton>
        <div className="day-detail-titles">
          <h2 className="day-detail-title">{sel.name}</h2>
          <a className="day-detail-meta day-link" href={sel.url} target="_blank" rel="noreferrer noopener">Open the site <ExternalLink size={12} aria-hidden="true" /></a>
        </div>
      </header>
      <div className="day-actions">
        <Button variant="primary" size="sm" icon={<RefreshCw size={14} />} onClick={() => void act("Reading the site…", () => api(`/sites/${sel.id}/check`, { method: "POST" }))}>Check now</Button>
        {(sel.mode !== "api") && <Button size="sm" icon={<LogIn size={14} />} disabled={!browser} title={browser ? "" : "Rooks Browser is not running"} onClick={() => void act("Opening the browser…", () => api(`/sites/${sel.id}/sign-in`, { method: "POST" }), "Sign in in the window that opened, then press Check now")}>Sign in once</Button>}
        {(sel.mode !== "api") && <Button variant="ghost" size="sm" disabled={!browser} title="Delete the saved sign-in for this site" onClick={() => confirm(`Forget the saved sign-in for ${sel.name}? You can sign in again later.`) && void act("Forgetting the sign-in…", () => api(`/sites/${sel.id}/sign-out`, { method: "POST" }), "Saved sign-in removed")}>Forget sign-in</Button>}
        <IconButton label="Remove site" size="sm" onClick={() => confirm(`Remove ${sel.name}? Your sign-in in the browser stays.`) && void act("Removing…", () => api(`/sites/${sel.id}`, { method: "DELETE" })).then(() => setSel(null))}><Trash2 size={14} /></IconButton>
      </div>

      {sel.status === "needs_sign_in" && <Notice tone="warn">{sel.status_detail}</Notice>}
      {sel.status === "error" && <Notice tone="danger">{sel.status_detail}</Notice>}
      {sel.recipe_info?.help && (
        <Notice title={sel.recipe_info.label}>
          <p>{sel.recipe_info.help}</p>
          {sel.recipe_info.kind === "api" && !sel.has_key && (
            <form className="day-add-row" onSubmit={(e) => { e.preventDefault(); void act("Saving the key…", () => api(`/sites/${sel.id}/key`, { body: { api_key: key } }), "Key saved in your computer's keychain").then(() => setKey("")); }}>
              <Input className="day-grow" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the key from the site" aria-label="Key from the site" autoComplete="off" />
              <Button type="submit" size="sm" icon={<KeyRound size={14} />} disabled={key.length < 8}>Save key</Button>
            </form>
          )}
          {sel.has_key && <p className="day-inline"><Check size={14} aria-hidden="true" /> Key saved securely.</p>}
        </Notice>
      )}

      <div className="day-tabs-row">
        <Tabs label="Site" value={tab} onChange={(t) => setTab(t as typeof tab)} items={[
          { id: "overview", label: "What's new" }, { id: "records", label: "Items", count: recs.length || undefined },
          { id: "schedule", label: "Schedule" }, { id: "do", label: "Make a change", count: pending.length || undefined },
        ]} />
      </div>

      {tab === "overview" && (
        <div className="day-stack">
          {overdue.length > 0 && <Notice tone="warn" title={`${overdue.length} overdue`}>{overdue.slice(0, 4).map((r) => r.title).join(", ")}{overdue.length > 4 ? "…" : ""}</Notice>}
          {sel.checks?.[0] ? (
            <Card className="day-digest">
              {sel.checks[0].digest.split("\n").map((l, i) => <p key={i}>{l}</p>)}
              <p className="day-hint">Checked {relTime(sel.checks[0].at)}</p>
            </Card>
          ) : <EmptyState className="day-empty-sm" title="Not read yet" action={<Button size="sm" onClick={() => void act("Reading the site…", () => api(`/sites/${sel.id}/check`, { method: "POST" }))}>Check now</Button>} />}
          {collections.length > 0 && <p className="day-hint">Found on this site: {collections.map((c) => `${c.count} ${c.name.toLowerCase()}`).join(" · ")}{sel.structure.files?.length ? ` · ${sel.structure.files.length} files` : ""}{forms.length ? ` · ${forms.length} forms` : ""}</p>}
          <Section title="Keep an eye on it" description="Checks only read the site. Anything that would change it waits for you.">
            <form className="day-add-row" onSubmit={(e) => { e.preventDefault(); void act("Setting it up…", () => api("/sites/watches", { body: { request: watchText, site_id: sel.id } }), "Done. Results arrive in your inbox").then(() => setWatchText("")); }}>
              <Input className="day-grow" value={watchText} onChange={(e) => setWatchText(e.target.value)} aria-label="What to watch for" placeholder="e.g. check every morning at 7 and tell me which jobs are overdue" />
              <Button type="submit" size="sm" disabled={watchText.trim().length < 5}>Set up</Button>
            </form>
            {(sel.watches ?? []).length > 0 && (
              <List label="Watches">
                {(sel.watches ?? []).map((w) => (
                  <Row key={w.id} leading={<BellRing size={14} />} title={`“${w.request}”`} meta={w.in_words}
                    actions={<>
                      <Button variant="ghost" size="sm" onClick={() => void act("Checking…", () => api(`/sites/watches/${w.id}/run`, { method: "POST" }), "Sent to your inbox")}>Run now</Button>
                      <IconButton label="Stop watching" size="sm" onClick={() => void act("", () => api(`/sites/watches/${w.id}`, { method: "DELETE" }))}><X size={14} /></IconButton>
                    </>} />
                ))}
              </List>
            )}
          </Section>
          {(sel.structure.files ?? []).length > 0 && (
            <Section title="Files on the site">
              <List label="Files on the site">
                {sel.structure.files!.slice(0, 30).map((f) => (
                  <Row key={f.url} title={f.name} actions={<Button variant="ghost" size="sm" icon={<FileDown size={14} />} onClick={() => void act("Fetching…", () => api(`/sites/${sel.id}/fetch-file`, { body: { url: f.url } }), "Added to Files").then(() => navigate("/files"))}>Read it</Button>} />
                ))}
              </List>
            </Section>
          )}
        </div>
      )}

      {tab === "records" && (
        <div className="day-stack">
          <div className="day-actions">
            {collections.length > 1 && <Select aria-label="Show" className="day-auto" value={coll} onChange={(e) => setColl(e.target.value)}><option value="">Everything</option>{collections.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}</Select>}
            <span className="day-grow" />
            <Button size="sm" icon={<Download size={14} />} onClick={() => void act("Making the spreadsheet…", () => api<{ download: string }>(`/sites/${sel.id}/export`, { method: "POST" }).then((r) => window.open(r.download, "_blank")))}>Excel</Button>
            <Button size="sm" onClick={() => navigate("/assistant", { state: { draft: `Looking at ${sel.name} (site ${sel.id}): ` } })}>Ask about these</Button>
          </div>
          {!shown.length ? <EmptyState className="day-empty-sm" title="No items found yet" line="If the site needs a sign-in, sign in once first." action={<Button size="sm" onClick={() => void act("Reading the site…", () => api(`/sites/${sel.id}/check`, { method: "POST" }))}>Check now</Button>} /> : (
            <div className="day-table-wrap"><table className="day-table"><thead><tr><th>Item</th><th>Status</th><th>Starts</th><th>Due</th><th>Who</th><th>Where</th></tr></thead>
              <tbody>{shown.slice(0, 400).map((r) => <tr key={r.id} className={r.overdue ? "is-late" : r.done ? "is-done" : ""}>
                <td><a href={r.url} target="_blank" rel="noreferrer noopener">{r.title}</a>{collections.length > 1 && !coll ? <div className="day-hint">{r.collection}</div> : null}</td>
                <td><span className="day-badges">{r.status && <Badge tone={r.overdue ? "danger" : r.done ? "ok" : "neutral"}>{r.status}</Badge>}{r.overdue && <Badge tone="danger">overdue</Badge>}</span></td>
                <td>{short(r.start)}</td><td>{short(r.due)}</td><td>{r.person}</td><td>{r.location}</td></tr>)}</tbody></table></div>
          )}
        </div>
      )}

      {tab === "schedule" && <Schedule items={items} siteId={sel.id} onCalendar={() => void act("Adding to your calendar…", () => api<{ created: number }>(`/sites/${sel.id}/to-calendar`, { method: "POST" }).then((r) => toast.ok(`${r.created} added to your calendar`)))} />}

      {tab === "do" && (
        <div className="day-stack">
          {pending.map((a) => (
            <ApprovalCard key={a.id} title={a.summary} effect="external" detail="Waiting for your OK. Nothing changes on the site until you say yes."
              busy={busy === "Doing it…"}
              onApprove={() => void act("Doing it…", () => api(`/site-actions/${a.id}`, { body: { approve: true } }), "Done")}
              onDeny={() => void act("", () => api(`/site-actions/${a.id}`, { body: { approve: false } }), "Cancelled")} />
          ))}
          {!forms.length && <EmptyState className="day-empty-sm" title="No forms found on this site yet" line="After a check, the forms the site offers (update a status, add a note, submit a timesheet) appear here." />}
          {forms.length > 0 && (
            <Select label="What do you want to do?" value={formIdx} onChange={(e) => { const i = Number(e.target.value); setFormIdx(i); setVals(Object.fromEntries((forms[i]?.fields ?? []).map((f) => [f.name, f.value]))); }}>
              <option value={-1}>Choose…</option>{forms.map((f, i) => <option key={i} value={i}>{f.name} ({f.submit}) · {new URL(f.page_url).pathname}</option>)}
            </Select>
          )}
          {form && (
            <form className="day-form" onSubmit={(e) => { e.preventDefault(); void act("Preparing…", () => api(`/sites/${sel.id}/actions`, { body: { form: String(formIdx), values: vals } }), "Check it, then approve it below"); }}>
              {form.fields.filter((f) => f.type !== "hidden").map((f) => (
                f.options.length ? <Select key={f.name} label={f.label} value={vals[f.name] ?? ""} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                  : f.type === "textarea" ? <Textarea key={f.name} label={f.label} rows={3} value={vals[f.name] ?? ""} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />
                    : <Input key={f.name} label={f.label} type={f.type === "password" ? "password" : "text"} value={vals[f.name] ?? ""} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />
              ))}
              <div className="day-form-foot"><p className="day-hint">You will see exactly what will be sent before anything happens.</p><Button type="submit" variant="primary" size="sm">Prepare “{form.submit}”</Button></div>
            </form>
          )}
          {actions.filter((a) => a.site_id === sel.id && a.status !== "pending").length > 0 && (
            <List label="Earlier changes">
              {actions.filter((a) => a.site_id === sel.id && a.status !== "pending").slice(0, 10).map((a) => (
                <Row key={a.id} title={a.summary} meta={`${a.status === "done" ? "Done" : a.status === "denied" ? "Cancelled" : "Failed"} · ${relTime(a.created_at)}`} />
              ))}
            </List>
          )}
        </div>
      )}
    </div>
  );

  return (
    <Page title="Sites" wide className="day-page"
      description="The websites you work in: job trackers, rosters, project portals. Sign in once and the assistant reads them and tells you what changed. It never changes a site without asking you first."
      actions={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>Add a site</Button>}>
      {adding && (
        <Card as="section" className="day-gap" aria-label="Add a site">
          <form className="day-form" onSubmit={add}>
            <Input label="Web address" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste it from your browser, e.g. portal.mybuilder.com.au/jobs" />
            <Input label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Builder portal" />
            {!browser && <p className="day-hint">Sites that need a sign-in are read through Rooks Browser, which starts with the desktop app.</p>}
            <div className="day-actions"><Button type="submit" variant="primary" disabled={url.trim().length < 4}>Add and read it</Button><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button></div>
          </form>
        </Card>
      )}
      {busy && <Busy>{busy}</Busy>}
      {sites !== null && !problem && sites.length === 0 && !sel
        ? <EmptyState icon={<Globe size={24} />} title="No sites yet" line="Add the address of a site you use for work, and the assistant reads it for you."
            action={<Button icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add a site</Button>} />
        : <Split label="Sites" picked={!!sel} list={listPane} main={mainPane} />}
    </Page>
  );
}

/** A simple program view: one bar per dated item, today marked, late items marked. Positions are data, so they are CSS variables. */
function Schedule({ items, siteId, onCalendar }: { items: Item[]; siteId: number; onCalendar: () => void }) {
  const range = useMemo(() => {
    if (!items.length) return null;
    const today = day(new Date().toISOString());
    const lo = Math.min(today, ...items.map((i) => day(i.start)));
    const hi = Math.max(today, ...items.map((i) => day(i.end))) + 86400000;
    return { lo, hi, today };
  }, [items]);
  if (!items.length || !range) return <EmptyState className="day-empty-sm" title="Nothing with dates yet" line="Items with dates or times on the site show up here as a program." />;
  const pct = (t: number) => `${((t - range.lo) / (range.hi - range.lo)) * 100}%`;
  return (
    <div className="day-stack">
      <div className="day-actions"><Button variant="primary" size="sm" icon={<CalendarPlus size={14} />} onClick={onCalendar}>Add to my calendar</Button>
        <a className="ui-btn ui-btn-secondary ui-btn-sm" href={`/api/sites/${siteId}/calendar.ics`}><Download size={14} aria-hidden="true" /> Calendar file</a></div>
      <p className="day-hint">Done items are left out of your calendar. Adding twice does not duplicate.</p>
      <p className="day-gantt-key day-hint"><span className="day-gantt-swatch" /> planned <span className="day-gantt-swatch is-late" /> overdue <span className="day-gantt-swatch is-done" /> done <span className="day-gantt-swatch is-now" /> today</p>
      <div className="day-gantt" style={{ "--now": pct(range.today) } as CSSProperties}>
        {items.slice(0, 200).map((i) => (
          <div key={i.id} className="day-gantt-row">
            <div className="day-gantt-label" title={i.title}>{i.title}</div>
            <div className="day-gantt-track"><span className="day-gantt-now" /><span className={`day-gantt-bar${i.overdue ? " is-late" : i.done ? " is-done" : ""}`}
              style={{ "--from": pct(day(i.start)), "--to": pct(day(i.end) + 86400000) } as CSSProperties}
              title={`${i.title}: ${short(i.start)}${i.end !== i.start ? " to " + short(i.end) : ""}${i.status ? " · " + i.status : ""}`} /></div>
            <div className="day-gantt-when">{short(i.start)}{i.end !== i.start ? `–${short(i.end)}` : ""}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
