// B2: walk the knowledge graph from one entity: who and what it connects to, how many hops away, and by which links.
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { ErrorState, Input, List, Loading, Row, Section, Select } from "../ui";

type Step = { from: number; rel: string; to: number };
type WalkNode = { id: number; type: string; name: string; rel: string; direction: "in" | "out"; hops: number; path: Step[] };
export type Walk = { start: number; depth: number; direction: string; rel: string | null; nodes: WalkNode[]; truncated: boolean };

const nice = (rel: string) => rel.replace(/_/g, " ");

export default function GraphWalk({ id, name }: { id: number; name: string }) {
  const [depth, setDepth] = useState(2);
  const [direction, setDirection] = useState("both");
  const [rel, setRel] = useState("");
  const [walk, setWalk] = useState<Walk | null>(null);
  const [err, setErr] = useState("");
  const [, setParams] = useSearchParams();

  useEffect(() => {
    const q = new URLSearchParams({ eid: String(id), depth: String(depth), direction });
    if (rel.trim()) q.set("rel", rel.trim());
    api<Walk>(`/knowledge/graph/traverse?${q}`).then((w) => { setWalk(w); setErr(""); }).catch((e) => setErr(String(e?.message ?? e)));
  }, [id, depth, direction, rel]);

  const names: Record<number, string> = { [id]: name };
  walk?.nodes.forEach((n) => { names[n.id] = n.name; });
  const byHop = (walk?.nodes ?? []).reduce<Record<number, WalkNode[]>>((a, n) => ((a[n.hops] ??= []).push(n), a), {});

  return (
    <Section title="Connections">
      <div className="ag-form-row kn-walk">
        <Select label="How far" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
          {[1, 2, 3, 4].map((d) => <option key={d} value={d}>{d === 1 ? "Direct links" : `${d} steps`}</option>)}
        </Select>
        <Select label="Direction" value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="both">Both ways</option><option value="out">From {name}</option><option value="in">To {name}</option>
        </Select>
        <Input label="Only this link" placeholder="for example works at" value={rel} onChange={(e) => setRel(e.target.value)} />
      </div>
      <div aria-live="polite" className="ag-stack ag-gap-top">
        {err && <ErrorState title="I could not follow the links" line="Try fewer steps, or try again in a moment." />}
        {!walk && !err && <Loading rows={2} />}
        {walk && !walk.nodes.length && <p className="ag-note">No connections{rel.trim() ? ` by "${nice(rel.trim())}"` : ""} within {depth} step{depth > 1 ? "s" : ""}.</p>}
        {Object.entries(byHop).map(([hop, list]) => (
          <div key={hop}>
            <p className="ag-label">{hop === "1" ? "Directly linked" : `${hop} steps away`} ({list.length})</p>
            <List className="ag-list">
              {list.map((n) => (
                <Row key={n.id} title={n.name} onClick={() => setParams({ entity: String(n.id) })}
                  meta={<span className="graph-path" aria-label={`${n.type}. Path: ${n.path.map((s) => `${names[s.from] ?? s.from} ${nice(s.rel)} ${names[s.to] ?? s.to}`).join(", then ")}`}>
                    <span>{n.type}</span>
                    {n.path.map((s, i) => <span key={i} className="graph-step">{names[s.from] ?? s.from} <ArrowRight size={12} aria-hidden /> {nice(s.rel)} <ArrowRight size={12} aria-hidden /> {names[s.to] ?? s.to}</span>)}
                  </span>} />
              ))}
            </List>
          </div>
        ))}
        {walk?.truncated && <p className="ag-note">Showing the first {walk.nodes.length}. Narrow it with a link type or fewer steps.</p>}
      </div>
    </Section>
  );
}
