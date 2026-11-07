import { Brain, Download, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, EmptyState, ErrorState, IconButton, Input, Loading, Page, Section, Select } from "../ui";
import { errorText } from "../ui/toast";
import { relTime, useToast } from "../util";
import { SettingsGroup } from "./settings";

// Phase 4: fine-tuning. Datasets come from your own chats (user/assistant text only, redacted); training runs on a
// provider that offers it, because this container has no GPU. The finished model shows up in every model picker.
type Conv = { id: number; title: string; channel: string; updated_at: string; user_messages: number; assistant_messages: number };
type Dataset = { id: number; name: string; examples: number; chars: number; created_at: string; ready: boolean; note: string };
type Job = { id: number; dataset_id: number; connection_id: number; provider: string | null; base_model: string; status: string;
  fine_tuned_model: string; model_ref: string; error: string; created_at: string; updated_at: string };
type Provider = { id: number; name: string };

const DONE = new Set(["succeeded", "failed", "cancelled"]);
const tone = (s: string): "ok" | "danger" | "warn" => (s === "succeeded" ? "ok" : s === "failed" || s === "cancelled" ? "danger" : "warn");

export default function FineTune() {
  const toast = useToast();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState("");
  const [name, setName] = useState("");
  const [system, setSystem] = useState("");
  const [form, setForm] = useState({ dataset_id: 0, connection_id: 0, base_model: "gpt-4.1-mini-2025-04-14", suffix: "" });
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const [c, d, j, p] = await Promise.all([api<Conv[]>("/finetune/conversations"), api<Dataset[]>("/finetune/datasets"),
      api<Job[]>("/finetune/jobs"), api<{ providers: Provider[] }>("/providers")]);
    const provs = p.providers ?? [];
    setConvs(c); setDatasets(d); setJobs(j); setProviders(provs);
    setForm((f) => ({ ...f, dataset_id: f.dataset_id || d.find((x) => x.ready)?.id || 0, connection_id: f.connection_id || provs[0]?.id || 0 }));
    setLoaded(true);
  }, []);
  const first = useCallback(() => { setFailed(""); load().catch((e) => setFailed(errorText(e))); }, [load]);
  useEffect(() => { first(); }, [first]);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    try { await fn(); if (ok) toast.ok(ok); await load(); } catch (e) { toast.err(e); }
    setBusy("");
  };
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Page title="Fine-tune" className="st-page"
      description="Teach a model your style from your own chats. Only your messages and the assistant's answers are used, with secrets removed. Training runs at a provider that offers it and costs money there.">
      {failed && !loaded ? <ErrorState title="Fine-tuning did not load" line={failed} onRetry={first} /> : !loaded ? <Loading rows={4} label="Loading your conversations" /> : (
        <>
          <Section title="1. Pick conversations" actions={<>
            <span className="st-small">{picked.size} picked</span>
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set(convs.map((c) => c.id)))}>All</Button>
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>None</Button>
          </>}>
            {!convs.length ? <EmptyState icon={<Brain size={22} />} title="No conversations yet" line="Chat with the assistant first; answered conversations show here." /> : (
              <div className="st-stack">
                <div className="st-group st-picklist">
                  {convs.map((c) => (
                    <label key={c.id} className="st-pick">
                      <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                      <span className="st-pick-title">{c.title}</span>
                      <span className="st-pick-meta">{c.channel} · {c.user_messages + c.assistant_messages} messages · {relTime(c.updated_at)}</span>
                    </label>
                  ))}
                </div>
                <div className="st-form-grid">
                  <Input label="Dataset name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
                  <Input label="System message" hint="Optional, added to every example." value={system} onChange={(e) => setSystem(e.target.value)} maxLength={4000} />
                </div>
                <div className="st-form-actions">
                  <Button variant="primary" disabled={!picked.size || !!busy} busy={busy === "dataset"}
                    onClick={() => run("dataset", () => api("/finetune/datasets", { body: { name, system, conversation_ids: [...picked] } }), "Dataset built")}>
                    {busy === "dataset" ? "Building…" : "Build dataset"}</Button>
                </div>
              </div>
            )}
          </Section>

          <Section title="2. Datasets" description="The file also works for training on your own graphics card.">
            {!datasets.length ? <p className="st-small">None yet. Build one above.</p> : (
              <SettingsGroup label="Datasets">
                {datasets.map((d) => (
                  <div key={d.id} className="st-item">
                    <div className="st-item-text">
                      <span className="st-item-title">{d.name}</span>
                      <span className="st-item-meta">{d.examples} examples · {(d.chars / 1000).toFixed(0)}k characters · {relTime(d.created_at)}{d.note ? ` · ${d.note}` : ""}</span>
                    </div>
                    <span className="st-item-actions">
                      <a className="ui-btn ui-btn-ghost ui-btn-sm" href={`/api/finetune/datasets/${d.id}/download`}><Download size={13} aria-hidden="true" /> Download</a>
                      <IconButton size="sm" label={`Delete ${d.name}`} onClick={() => run("del", () => api(`/finetune/datasets/${d.id}`, { method: "DELETE" }))}><Trash2 size={14} /></IconButton>
                    </span>
                  </div>
                ))}
              </SettingsGroup>
            )}
          </Section>

          <Section title="3. Train at a provider" description="Works with providers that offer OpenAI-style fine-tuning (OpenAI, Mistral, compatible servers). Check the provider's prices first.">
            <div className="st-stack">
              <div className="st-form-grid">
                <Select label="Dataset" value={form.dataset_id} onChange={(e) => setForm({ ...form, dataset_id: Number(e.target.value) })}>
                  <option value={0}>Pick a dataset</option>
                  {datasets.filter((d) => d.ready).map((d) => <option key={d.id} value={d.id}>{d.name} ({d.examples})</option>)}
                </Select>
                <Select label="Provider" value={form.connection_id} onChange={(e) => setForm({ ...form, connection_id: Number(e.target.value) })}>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Input label="Base model" value={form.base_model} onChange={(e) => setForm({ ...form, base_model: e.target.value })} />
                <Input label="Name suffix" hint="Optional." value={form.suffix} onChange={(e) => setForm({ ...form, suffix: e.target.value })} maxLength={40} />
              </div>
              <div className="st-form-actions">
                <Button variant="primary" disabled={!form.dataset_id || !form.connection_id || !form.base_model.trim() || !!busy} busy={busy === "job"}
                  onClick={() => run("job", () => api("/finetune/jobs", { body: form }), "Training started")}>
                  {busy === "job" ? "Starting…" : "Start training"}</Button>
              </div>
            </div>
          </Section>

          <Section title="Training jobs">
            {!jobs.length ? <p className="st-small">No training jobs yet.</p> : (
              <SettingsGroup label="Training jobs">
                {jobs.map((j) => (
                  <div key={j.id} className="st-item">
                    <div className="st-item-text">
                      <span className="st-item-title">{j.fine_tuned_model || j.base_model} <Badge tone={tone(j.status)}>{j.status}</Badge></span>
                      <span className="st-item-meta">{j.provider ?? "removed provider"} · dataset #{j.dataset_id} · {relTime(j.created_at)}{j.error ? ` · ${j.error}` : ""}</span>
                    </div>
                    <span className="st-item-actions">
                      {j.model_ref && <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(j.model_ref).then(() => toast.ok("Model copied: pick it in Models or a chat"))}>Copy model</Button>}
                      {!DONE.has(j.status) && <>
                        <IconButton size="sm" label={busy === `r${j.id}` ? "Checking" : "Check again"} disabled={busy === `r${j.id}`} onClick={() => run(`r${j.id}`, () => api(`/finetune/jobs/${j.id}/refresh`, { method: "POST" }))}><RefreshCw size={14} /></IconButton>
                        <IconButton size="sm" label="Cancel" onClick={() => run(`c${j.id}`, () => api(`/finetune/jobs/${j.id}/cancel`, { method: "POST" }), "Cancelled")}><X size={14} /></IconButton>
                      </>}
                    </span>
                  </div>
                ))}
              </SettingsGroup>
            )}
          </Section>
        </>
      )}
    </Page>
  );
}
