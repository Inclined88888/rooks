// feat/memory-core: "What I improved" on Home - last night's note, suggestions you approve, and the on/off switch.
import { Check, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Button } from "../ui";
import "../pages/agents/agents.css";
import "./memory.css";

type Item = { id: number; day: string; title: string; detail: string; status: string };
type Data = { enabled: boolean; idle_minutes: number; last_run: string; note: Item | null; proposals: Item[] };

export function ImprovedCard() {
  const [d, setD] = useState<Data | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Data>("/knowledge/improvements").then(setD).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  const toggle = async () => setD(await api<Data>("/knowledge/improvements/settings", { method: "PUT", body: { enabled: !d.enabled } }));
  const decide = async (p: Item, choice: "approve" | "decline") => { await api(`/knowledge/improvements/${p.id}/${choice}`, { body: {} }); load(); };
  const runNow = async () => { setBusy(true); try { await api("/knowledge/improvements/run", { body: {} }); await load(); } finally { setBusy(false); } };
  return (
    <section className="ui-card kn-improved" aria-label="What I improved">
      <div className="ag-bar">
        <Sparkles size={16} aria-hidden="true" className="kn-improved-icon" />
        <h3 className="ag-h3">What I improved</h3>
        <span className="ag-meta">{d.note ? `overnight, ${d.note.day}` : ""}</span>
        <label className="ag-check ag-bar-end" title={`Runs once a night while your computer is on and you've been away ${d.idle_minutes} minutes`}>
          <input type="checkbox" checked={d.enabled} onChange={toggle} /> Get better overnight
        </label>
      </div>
      <p className="ag-body ag-gap-top">{d.note ? d.note.detail : d.enabled ? "Tonight, while you're away, I'll look back over the day and get a little better at your work." : "Overnight improvement is off."}</p>
      {d.proposals.map((p) => (
        <div key={p.id} className="kn-proposal">
          <div className="ag-grow"><b>{p.title}?</b><p className="ag-note">{p.detail} This changes how I act for you, so it's your call.</p></div>
          <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => decide(p, "approve")}>Yes</Button>
          <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => decide(p, "decline")}>No thanks</Button>
        </div>
      ))}
      {!d.note && d.enabled && <div className="ag-gap-top"><Button size="sm" variant="ghost" busy={busy} onClick={runNow}>{busy ? "Looking back…" : "Do it now"}</Button></div>}
    </section>
  );
}
