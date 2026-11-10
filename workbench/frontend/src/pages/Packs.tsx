// Packs gallery: one-click add, through the skills security gate (feat/v02-packs).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { api } from "../api";
import { tierLabel } from "../packs/logic";
import { useToast } from "../util";
import { Badge, Button, EmptyState, ErrorState, Loading, Page } from "../ui";
import { plainError } from "./agents/kit";
import "../packs/packs.css";

type Gate = Record<string, { risk: string; findings: number; extra_permissions: string[] }>;
export type Pack = {
  id: string; name: string; tagline: string; for: string; tier: string; page: string; includes: string[]; version: string;
  skills: { name: string; description: string }[]; installed: boolean; allowed: boolean; gate: Gate;
};

export default function Packs() {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState("");
  const toast = useToast();
  const load = () => api<Pack[]>("/packs").then((p) => { setPacks(p); setErr(null); }).catch(setErr);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (p: Pack, what: "add" | "remove") => {
    setBusy(p.id);
    try {
      await api(`/packs/${p.id}/${what}`, { method: "POST" });
      toast.ok(what === "add" ? `${p.name} added. Every skill passed the security check.` : `${p.name} removed. Your saved work is kept.`);
      await load();
    } catch (e) { toast.err(e); }
    setBusy("");
  };

  return (
    <Page wide className="ag-page pk-page" kicker="Your work" title="Packs"
      description="Shortcuts for the work you do. Add one in a click, remove it any time. Your assistant works the same without them.">
      {err && !packs ? <ErrorState title="The packs did not load" line={plainError(err)} onRetry={load} />
        : !packs ? <Loading rows={3} />
        : !packs.length ? <EmptyState title="No packs here yet" line="Packs arrive with updates; your assistant works the same without them." />
        : <div className="pk-gallery">
        {packs.map((p) => (
          <section key={p.id} className="pk-tile" aria-labelledby={`pk-${p.id}`}>
            <div className="pk-between">
              <h2 id={`pk-${p.id}`} className="pk-title">{p.name}</h2>
              <Badge tone={p.tier === "free" ? "ok" : "neutral"}>{tierLabel(p.tier, p.allowed)}</Badge>
            </div>
            <p className="ag-note">{p.tagline}</p>
            <p className="ag-meta">For {p.for.toLowerCase()}</p>
            <ul>{p.includes.map((x) => <li key={x}>{x}</li>)}</ul>
            {p.installed && (
              <div className="pk-gate-result" aria-label="Security check">
                <span className="ok"><ShieldCheck size={12} aria-hidden="true" /> {Object.keys(p.gate).length} skills passed the security check</span>
                {Object.entries(p.gate).map(([n, g]) => <span key={n}>{n}: {g.risk} risk, {g.findings} findings</span>)}
              </div>
            )}
            <div className="pk-foot">
              {p.installed ? <>
                <Link className="ui-btn ui-btn-primary" to={p.page}>Open</Link>
                <Button variant="ghost" busy={busy === p.id} onClick={() => act(p, "remove")}>Remove</Button>
              </> : (
                <Button variant="primary" busy={busy === p.id} disabled={!!busy && busy !== p.id} onClick={() => act(p, "add")}>{busy === p.id ? "Checking…" : "Add"}</Button>
              )}
            </div>
          </section>
        ))}
      </div>}
    </Page>
  );
}
