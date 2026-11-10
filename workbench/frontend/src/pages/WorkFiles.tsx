import { ExternalLink, Folder, FileText, MessageSquare, Save, Search } from "lucide-react";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { openExternal } from "../desktop";
import { Button, EmptyState, ErrorState, Input, List, Loading, Row, Tabs, useToast } from "../ui";
import { plainError } from "./day/parts";

/**
 * Files, "From work" (design 0012): the person's OneDrive and the SharePoint sites they follow, or their My Drive and
 * shared drives, and files shared with them, read in place through their own work account. The words for each place
 * come from the app (names), so a Google Workspace account sees Google's names. Save to Files keeps a copy here with where it came from; Open shows it
 * in the Room's browser (they sign in there once; on a work PC Edge may sign them in through Windows), or in their own browser
 * where the Room has none. Nothing here changes a work file: uploads, shares and edits wait for a yes in Needs you.
 */
type Item = { file: string; name: string; folder: boolean; where: string; web_url: string; modified?: string; match?: string };
type Site = { id: string; name: string };
type Names = { home: string; sites: string; site: string; files: string };
type Status = { account: { email: string } | null; features: { id: string; state: string }[]; names?: Names };
const MICROSOFT: Names = { home: "OneDrive", sites: "SharePoint sites", site: "SharePoint site", files: "OneDrive and SharePoint" };
type RoomStatus = { running?: boolean; can?: { browser?: boolean } };

export default function WorkFiles({ onSaved }: { onSaved?: (id: number) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [where, setWhere] = useState<"onedrive" | "sites" | "shared">("onedrive");
  const [items, setItems] = useState<Item[] | null>(null);
  const [sites, setSites] = useState<Site[] | null>(null);
  const [trail, setTrail] = useState<{ label: string; query: string }[]>([]);
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState("");
  const [room, setRoom] = useState<RoomStatus | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  const list = useCallback(async (q: string) => {
    setItems(null); setProblem("");
    try { setItems((await api<{ items: Item[] }>(`/work/files${q}`)).items); }
    catch (e) { setItems([]); setProblem(plainError(e, "Your work files did not load.")); }
  }, []);

  useEffect(() => {
    api<Status>("/work/status").then(setStatus).catch(() => setStatus({ account: null, features: [] }));
    api<RoomStatus>("/room/status").then(setRoom).catch(() => setRoom(null));
  }, []);
  const readOn = !!status?.features.find((f) => f.id === "files_read" && f.state === "on");
  const names = status?.names ?? MICROSOFT;

  useEffect(() => {
    if (!readOn) return;
    setTrail([]);
    if (where === "onedrive") void list("");
    else if (where === "shared") void list("?shared=true");
    else { setItems([]); api<{ sites: Site[] }>("/work/sites").then((r) => setSites(r.sites)).catch((e) => { setSites([]); setProblem(plainError(e)); }); }
  }, [where, readOn, list]);

  if (status === null) return <Loading rows={3} label="Checking your work account" />;
  if (!readOn) {
    return <EmptyState icon={<FileText size={22} />} title="Your work files are not connected"
      line={status.account ? `Turn on Files: read in Work apps to see ${names.files} here.` : "Connect your work account in Work apps to see your work files here."}
      action={<Link className="ui-btn ui-btn-primary ui-btn-sm" to="/work">Work apps</Link>} />;
  }

  const search = (e: FormEvent) => { e.preventDefault(); if (query.trim()) void list(`?query=${encodeURIComponent(query.trim())}`); };
  const enter = (label: string, q: string) => { setTrail((t) => [...t, { label, query: q }]); void list(q); };
  const save = async (it: Item) => {
    try { const f = await api<{ id: number; name: string }>("/work/files/save", { body: { file: it.file } }); toast.ok(`${f.name} saved to Files`); onSaved?.(f.id); }
    catch (e) { toast.err(e); }
  };
  const inRoom = !!room?.can?.browser;
  const open = async (it: Item) => {
    if (!inRoom) { void openExternal(it.web_url); return; }
    try { await api("/room/browser/open", { body: { address: it.web_url } }); toast.ok(`${it.name} is open in the Room's browser`); navigate("/room"); }
    catch (e) { toast.err(e); }
  };
  const ask = (it: Item) => navigate("/assistant", { state: { draft: `About my work file “${it.name}” (work file ${it.file}): ` } });

  return (
    <div className="day-stack">
      <div className="day-tabs-row">
        <Tabs label="Where" value={where} onChange={(v) => setWhere(v as typeof where)}
          items={[{ id: "onedrive", label: names.home }, { id: "sites", label: names.sites }, { id: "shared", label: "Shared with me" }]} />
      </div>
      <form className="day-add-row" onSubmit={search}>
        <Search size={16} aria-hidden="true" className="day-muted-icon" />
        <Input className="day-grow" aria-label="Search your work files" placeholder={`Search ${names.files}`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button type="submit" size="sm" disabled={!query.trim()}>Search</Button>
      </form>
      {trail.length > 0 && <p className="day-hint">{trail.map((t) => t.label).join(" › ")} · <button type="button" className="st-link" onClick={() => { setTrail([]); setWhere("onedrive"); void list(""); }}>Back to {names.home}</button></p>}
      {problem && <ErrorState title="That did not load" line={problem} />}
      {where === "sites" && trail.length === 0 && (
        sites === null ? <Loading rows={2} label="Loading your sites" /> : sites.length === 0 ? <p className="day-hint">No {names.sites.toLowerCase()} here yet.</p> : (
          <List label={names.sites}>{sites.map((s) => <Row key={s.id} title={s.name} meta={names.site.charAt(0).toUpperCase() + names.site.slice(1)} onClick={() => enter(s.name, `?site=${encodeURIComponent(s.id)}`)} />)}</List>
        ))}
      {(where !== "sites" || trail.length > 0) && (items === null ? <Loading rows={4} label="Loading your work files" /> : items.length === 0 && !problem ? <p className="day-hint">Nothing here.</p> : (
        <List label="Work files">
          {items.map((it) => it.folder ? (
            <Row key={it.file} title={it.name} meta={`Folder · ${it.where}`} leading={<Folder size={16} aria-hidden="true" />}
              onClick={() => enter(it.name, `?folder=${encodeURIComponent(it.file)}`)} />
          ) : (
            <Row key={it.file} title={it.name} meta={[it.where, it.match].filter(Boolean).join(" · ")} leading={<FileText size={16} aria-hidden="true" />}
              actions={<>
                <Button size="sm" icon={<Save size={13} />} onClick={() => void save(it)}>Save to Files</Button>
                <Button size="sm" icon={<ExternalLink size={13} />} onClick={() => void open(it)}>{inRoom ? "Open in the Room's browser" : "Open in your browser"}</Button>
                <Button size="sm" variant="ghost" icon={<MessageSquare size={13} />} onClick={() => ask(it)}>Ask about it</Button>
              </>} />
          ))}
        </List>
      ))}
      <p className="day-hint">Reading is all this does. Uploading, sharing and changing a work file always wait for your yes in Needs you.</p>
    </div>
  );
}
