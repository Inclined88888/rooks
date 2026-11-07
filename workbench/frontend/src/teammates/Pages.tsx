// feat/grok-style: Pages. Reports and plans your teammates save, which you can edit, export and share.
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FileText, Plus } from "lucide-react";
import { api } from "../api";
import { useToast } from "../util";
import { Badge, Button, EmptyState, ErrorState, Input, Loading, Page as PageFrame, Textarea } from "../ui";
import { plainError, useLoad } from "../pages/agents/kit";
import "../pages/agents/agents.css";
import "./teammates.css";

type Page = { id: number; title: string; body?: string; shared: boolean; share_path: string; updated_at: string; teammate_id: number | null };

export default function Pages() {
  const { id } = useParams();
  const nav = useNavigate();
  const pages = useLoad(() => api<Page[]>("/pages"), []);
  const list = pages.data ?? [];
  const [page, setPage] = useState<Page | null>(null);
  const [edit, setEdit] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [again, setAgain] = useState(0);
  const toast = useToast();
  const load = pages.reload;
  useEffect(() => { setEdit(false); setErr(null); if (id) api<Page>(`/pages/${id}`).then(setPage).catch(setErr); else setPage(null); }, [id, again]);
  const act = useCallback(async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { toast.err(e); } }, [toast]);
  const make = () => act(async () => { const p = await api<Page>("/pages", { body: { title: "Untitled page", body: "" } }); load(); nav(`/pages/${p.id}`); });
  return <PageFrame wide className="ag-page tm-page-frame" title="Pages" description="Reports and plans your teammates save. Edit them, export them, or share a read-only link."
    actions={<Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={make}>New page</Button>}>
  {pages.error && !pages.data ? <ErrorState title="Your pages did not load" line={plainError(pages.error)} onRetry={load} />
  : pages.data && !list.length ? <EmptyState icon={<FileText size={20} />} title="No pages yet" line="Ask a teammate to save that as a page, or start one yourself."
      action={<Button variant="primary" icon={<Plus size={14} />} onClick={make}>New page</Button>} />
  : <div className="tm-shell">
    <nav className="tm-side" aria-label="Pages">
      <div className="tm-side-head"><h2 className="ag-h3">All pages</h2></div>
      {!pages.data && <Loading rows={3} />}
      {list.map((p) => <button key={p.id} type="button" className={`tm-person${String(p.id) === id ? " on" : ""}`} aria-current={String(p.id) === id || undefined} onClick={() => nav(`/pages/${p.id}`)}>
        <span><b>{p.title}</b><small>{p.shared ? "Shared · " : ""}{p.updated_at?.slice(0, 10)}</small></span></button>)}
    </nav>
    <section className="tm-chat" aria-label="Page">
      {page ? <>
        <header className="tm-chat-head"><div>{edit ? <Input aria-label="Title" value={page.title} onChange={(e) => setPage({ ...page, title: e.target.value })} /> : <b>{page.title}</b>}</div>
          {page.shared && <Badge>Shared</Badge>}
          <Button size="sm" variant="ghost" onClick={() => act(async () => { if (edit) { await api(`/pages/${page.id}`, { method: "PATCH", body: { title: page.title, body: page.body } }); load(); } setEdit(!edit); })}>{edit ? "Done" : "Edit"}</Button>
          <a className="ui-btn ui-btn-ghost ui-btn-sm" href={`/api/pages/${page.id}/export.html`}>Export</a>
          <Button size="sm" variant="ghost" onClick={() => act(async () => setPage({ ...page, ...(await api<Page>(`/pages/${page.id}/share?on=${!page.shared}`, { method: "POST" })) }))}>{page.shared ? "Stop sharing" : "Share link"}</Button>
          <Button size="sm" variant="ghost" onClick={() => { if (confirm("Delete this page?")) act(async () => { await api(`/pages/${page.id}`, { method: "DELETE" }); load(); nav("/pages"); }); }}>Delete</Button></header>
        {page.shared && <div className="tm-pad tm-share">
          <p className="ag-note">Anyone with the link can read it.</p>
          <Button size="sm" onClick={() => act(async () => { await navigator.clipboard.writeText(`${location.origin}${page.share_path}`); toast.ok("Link copied"); })}>Copy link</Button>
          <a className="ag-meta" href={page.share_path} target="_blank" rel="noreferrer">Open the shared page</a>
        </div>}
        {edit ? <Textarea aria-label="Page text" className="tm-editor" value={page.body ?? ""} onChange={(e) => setPage({ ...page, body: e.target.value })} />
          : <iframe className="tm-viewer" title={page.title} sandbox="" src={`/api/pages/${page.id}/export.html`} />}
      </> : id && err ? <div className="tm-pad tm-state"><ErrorState title="That page did not open" line={plainError(err)} onRetry={() => setAgain((n) => n + 1)} /></div>
        : id ? <div className="tm-pad tm-state"><Loading rows={4} /></div>
        : <EmptyState title="Pick a page" line="Or make a new one." />}
    </section>
  </div>}
  </PageFrame>;
}
