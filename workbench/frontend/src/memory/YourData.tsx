// feat/memory-core: Your data - automatic backups with restore, download everything, bring history from other apps.
import { Download, HardDriveDownload, RotateCcw, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../api";
import { relTime } from "../util";
import { Badge, Button, List, Row, Section, Select } from "../ui";
import { Gate, useLoad } from "../pages/agents/kit";

type Backup = { name: string; size: number; at: string; kind: string };
const SOURCES = [
  { id: "chatgpt", label: "ChatGPT", hint: "Settings → Data controls → Export. Upload the .zip you get by email." },
  { id: "claude", label: "Claude", hint: "Settings → Privacy → Export data. Upload the .zip." },
  { id: "grok", label: "Grok", hint: "Settings → Data → Download your data. Upload the .zip or .json." },
  { id: "notion", label: "Notion", hint: "Settings → Export → Markdown & CSV. Upload the .zip." },
  { id: "obsidian", label: "Obsidian", hint: "Zip your vault folder and upload it." },
];

export function YourData({ toast }: { toast: { ok: (t: string) => void; err: (e: unknown) => void } }) {
  const backups = useLoad(() => api<{ backups: Backup[] }>("/knowledge/backups").then((d) => d.backups), []);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [source, setSource] = useState("chatgpt");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = backups.reload;
  const backupNow = async () => { try { await api("/knowledge/backups", { body: {} }); toast.ok("Backed up"); load(); } catch (e) { toast.err(e); } };
  const restore = async (name: string) => {
    setConfirm(null);
    try { await api(`/knowledge/backups/${name}/restore`, { body: {} }); toast.ok("Restored. I kept a copy of how things were just before, in case you change your mind."); load(); }
    catch (e) { toast.err(e); }
  };
  const upload = async (f: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`/api/knowledge/import/${source}`, { method: "POST", body: fd, credentials: "same-origin", headers: { "X-Workbench": "1" } });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail ?? "Import failed");
      toast.ok(`Brought in ${j.chats ?? j.notes ?? 0} ${j.chats !== undefined ? "chats" : "notes"} from ${j.source}${j.skipped ? ` (${j.skipped} already here)` : ""}`);
    } catch (e) { toast.err(e); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const hint = SOURCES.find((s) => s.id === source)?.hint;
  return (
    <div>
      <Section title="Backups" description="I back everything up on this computer once a day and keep two weeks. Restoring keeps a copy of how things were, so it can be undone."
        actions={<Button size="sm" icon={<HardDriveDownload size={14} />} onClick={backupNow}>Back up now</Button>}>
        <Gate state={backups} rows={2}>{(list) => list.length ? (
          <List className="ag-list" label="Backups">
            {list.slice(0, 8).map((b) => (
              <Row key={b.name} title={relTime(b.at)} meta={<><Badge>{b.kind}</Badge> {(b.size / 1e6).toFixed(1)} MB</>}
                actions={confirm === b.name
                  ? <><span className="ag-meta">Go back to this point?</span><Button size="sm" variant="primary" onClick={() => restore(b.name)}>Yes, restore</Button><Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button></>
                  : <Button size="sm" variant="ghost" icon={<RotateCcw size={14} />} onClick={() => setConfirm(b.name)}>Restore</Button>} />
            ))}
          </List>) : <p className="ag-note">No backups yet. The first one is made tonight, or now if you ask.</p>}
        </Gate>
      </Section>
      <Section title="Take everything with you" description="Chats, notes, tasks, what I know, and your files, in open formats. Free, always.">
        <a className="ui-btn ui-btn-secondary ui-btn-sm" href="/api/knowledge/export.zip"><Download size={14} aria-hidden="true" /> Download everything</a>
      </Section>
      <Section title="Bring your history">
        <div className="ag-bar">
          <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="From" className="kn-source">
            {SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
          <input ref={fileRef} type="file" accept=".zip,.json,.md,.txt" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <Button size="sm" variant="primary" icon={<Upload size={14} />} busy={busy} onClick={() => fileRef.current?.click()}>{busy ? "Bringing it in…" : "Choose the export file"}</Button>
        </div>
        <p className="ag-note ag-gap-top">{hint} It stays on this computer.</p>
      </Section>
    </div>
  );
}
