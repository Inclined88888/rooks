// feat/grok-style: the Vault. Logins, cards, addresses and notes. Secrets are masked; reveal is for you only.
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { api } from "../api";
import { useToast } from "../util";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Loading, Page, Section, Tabs } from "../ui";
import { plainError, useLoad } from "../pages/agents/kit";
import "../pages/agents/agents.css";
import "./teammates.css";

type Item = { id: number; kind: string; label: string; fields: Record<string, string>; secret_hints: Record<string, string>; teammates?: number[] };
type Kinds = Record<string, { label: string; fields: { id: string; label: string; secret: boolean }[] }>;
type Listing = { items: Item[]; backend: string; kinds: Kinds };

export default function Vault() {
  const vault = useLoad(() => api<Listing>("/vault"), []);
  const data = vault.data;
  const toast = useToast();
  const [kind, setKind] = useState("login");
  const [label, setLabel] = useState("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<number, Record<string, string>>>({});
  const [err, setErr] = useState("");
  const load = vault.reload;
  const fields = data?.kinds?.[kind]?.fields ?? [];
  const desc = `Saved logins, cards and addresses your teammates can use without ever seeing them. Stored ${data?.backend === "keychain" ? "in your system keychain" : "encrypted on this computer"}.`;
  return <Page className="ag-page tm-settings" title="Vault" description={desc}>
    {vault.error && !data ? <ErrorState title="The Vault did not open" line={plainError(vault.error)} onRetry={load} /> : !data ? <Loading rows={4} /> : <>
    <Card as="section" className="ag-form" aria-labelledby="vault-add-h">
      <h2 id="vault-add-h" className="ag-h3">Add to Vault</h2>
      <Tabs size="sm" label="Kind" value={kind} onChange={(k) => { setKind(k); setVals({}); }} items={Object.entries(data.kinds ?? {}).map(([k, v]) => ({ id: k, label: v.label }))} />
      <form className="ag-form" onSubmit={async (e) => { e.preventDefault(); setErr("");
        try { await api("/vault", { body: { kind, label, values: vals } }); setLabel(""); setVals({}); load(); } catch (x) { setErr((x as Error).message); } }}>
        <Input label="Name" value={label} placeholder="For example Supplier portal" onChange={(e) => setLabel(e.target.value)} />
        <div className="ag-form-row">{fields.map((f) => <Input key={f.id} label={f.label} type={f.secret ? "password" : "text"} autoComplete="off" value={vals[f.id] ?? ""}
          onChange={(e) => setVals({ ...vals, [f.id]: e.target.value })} />)}</div>
        {err && <p className="ag-err">{err}</p>}
        <div><Button size="sm" variant="primary" type="submit" disabled={!label.trim()}>Save</Button></div>
      </form>
    </Card>
    <Section title="Saved" className="ag-section-gap">
      {!data.items.length ? <EmptyState icon={<KeyRound size={20} />} title="Nothing saved yet" line="When a teammate needs a login it asks with a secure form in the chat." />
      : <ul className="ag-grid tm-vault">{data.items.map((it) => <li key={it.id} className="ui-card tm-card">
        <div className="tm-card-head"><b>{it.label}</b><Badge>{data.kinds[it.kind]?.label ?? it.kind}</Badge></div>
        {Object.entries(it.fields).filter(([, v]) => v).map(([k, v]) => <p key={k} className="ag-meta">{k}: {v}</p>)}
        {Object.entries(shown[it.id] ? Object.fromEntries(Object.keys(it.secret_hints).map((k) => [k, shown[it.id][k]])) : it.secret_hints).map(([k, v]) =>
          <p key={k} className="ag-meta">{k}: <code className="ag-mono">{v}</code></p>)}
        <div className="ag-bar">
          <Button size="sm" variant="ghost" onClick={async () => {
            if (shown[it.id]) { const s = { ...shown }; delete s[it.id]; setShown(s); return; }
            try { const r = await api<{ values: Record<string, string> }>(`/vault/${it.id}/reveal`, { method: "POST" }); setShown({ ...shown, [it.id]: r.values }); } catch (e) { toast.err(e); }
          }}>{shown[it.id] ? "Hide" : "Reveal"}</Button>
          <Button size="sm" variant="ghost" onClick={async () => { if (confirm(`Delete ${it.label}?`)) { try { await api(`/vault/${it.id}`, { method: "DELETE" }); load(); } catch (e) { toast.err(e); } } }}>Delete</Button>
        </div>
      </li>)}</ul>}
    </Section>
    </>}
  </Page>;
}
