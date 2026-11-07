import { BookOpen, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Empty, Markdown, useToast } from "../../util";

type Skill = { id: number; name: string; description: string; steps: string; uses: number; source: string; enabled: number };

/** Skills: procedures written here or learned by the assistant. Also used by the Skills page. */
export function SkillsTab() {
  const [items, setItems] = useState<Skill[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState<Skill | null>(null);
  const toast = useToast();
  const load = () => api<Skill[]>("/skills").then((r) => setItems(r.filter((s) => s.source !== "github"))).catch(toast.err);
  useEffect(() => { load(); }, []);
  const save = async () => {
    if (!draft) return;
    try {
      if (draft.id) await api(`/skills/${draft.id}`, { method: "PUT", body: { ...draft, enabled: !!draft.enabled } });
      else await api("/skills", { body: { ...draft, enabled: true } });
      setDraft(null); load();
    } catch (e) { toast.err(e); }
  };
  return (
    <div className="col gap-lg">
      <div className="row"><p className="muted grow" style={{ margin: 0 }}>Procedures written here or learned by the assistant after complex tasks. Edit, disable or add your own.</p>
        <button className="ui-btn" onClick={() => setDraft({ id: 0, name: "", description: "", steps: "", uses: 0, source: "user", enabled: 1 })}><Plus size={14} /> Skill</button></div>
      {draft && (
        <div className="card col">
          <input className="ui-input mono" disabled={!!draft.id} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="short-kebab-name" />
          <input className="ui-input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="When to use it" />
          <textarea className="ui-input mono" rows={8} value={draft.steps} onChange={(e) => setDraft({ ...draft, steps: e.target.value })} placeholder={"1. ...\n2. ..."} />
          <div className="row"><button className="ui-btn ui-btn-primary" onClick={save}>Save</button><button className="ui-btn ui-btn-ghost" onClick={() => setDraft(null)}>Cancel</button></div>
        </div>
      )}
      {items.length === 0 && !draft && <Empty icon={<BookOpen size={24} />} title="No skills yet" hint="Ask for something multi step, like 'plan my week from my calendar and tasks'." />}
      <div className="card flush">
        {items.map((s) => (
          <div key={s.id} className="col" style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
            <div className="row" style={{ cursor: "pointer" }} onClick={() => setOpen(open === s.id ? null : s.id)}>
              <strong className="mono grow">{s.name}</strong>
              <span className="badge">{s.source === "auto" ? "learned" : s.source}</span>
              <span className="faint small">used {s.uses}×</span>
            </div>
            <div className="muted small">{s.description}</div>
            {open === s.id && (
              <>
                <Markdown text={s.steps} />
                <div className="row">
                  <button className="ui-btn ui-btn-sm" onClick={() => setDraft(s)}>Edit</button>
                  <button className="ui-btn ui-btn-sm" onClick={async () => { await api(`/skills/${s.id}`, { method: "PUT", body: { ...s, enabled: !s.enabled } }); load(); }}>{s.enabled ? "Disable" : "Enable"}</button>
                  <button className="ui-btn ui-btn-ghost ui-btn-sm ui-btn-danger" onClick={async () => { if (confirm(`Delete skill ${s.name}?`)) { await api(`/skills/${s.id}`, { method: "DELETE" }); load(); } }}><Trash2 size={13} /></button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
