import { Brain, Check, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Button, EmptyState, ErrorState, IconButton, Input, Loading, Page, Section, Select, Textarea } from "../ui";
import { errorText } from "../ui/toast";
import { relTime, useToast } from "../util";
import { Fact, groupFacts, sourceLabel } from "../learn/text";
import { SettingRow, SettingsGroup, Switch } from "./settings/index";

type Settings = { memory: boolean; memory_in_chat: boolean; notice_patterns: boolean; suggest: boolean };
type Work = { kind: string; label: string; times: number };
type Legacy = { id: number; content: string; kind: string; source: string; updated_at: string };
type Data = { facts: Fact[]; categories: Record<string, string>; legacy: Legacy[]; work: Work[] };
type Lesson = { id: number; lesson: string; created_at: string };

const SWITCHES: { key: keyof Settings; label: string; hint: string }[] = [
  { key: "memory", label: "Learn about me as we work", hint: "From chats, files, tasks and things you show me. Kept on this computer, encrypted." },
  { key: "memory_in_chat", label: "Use what I know in answers", hint: "Off means I answer without your notes, even though they stay saved." },
  { key: "notice_patterns", label: "Notice my routines", hint: "Spot work you repeat, like a Monday report." },
  { key: "suggest", label: "Offer to take things over", hint: "Suggest one-click routines. Nothing goes out without your OK." },
];

/** "What I know about you": everything the assistant has learned, in plain words, editable and deletable. */
export default function AboutYou() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ content: "", category: "fact" });
  const [editing, setEditing] = useState<{ id: number; content: string } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const toast = useToast();

  const load = useCallback((query = q) => {
    setFailed("");
    api<Data>(`/learn/facts${query.trim() ? `?q=${encodeURIComponent(query)}` : ""}`).then(setData).catch((e) => setFailed(errorText(e)));
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load("");
    api<Settings>("/learn/settings").then(setSettings).catch(() => {});
    api<Lesson[]>("/learn/lessons").then(setLessons).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => (data ? groupFacts(data.facts, data.categories) : []), [data]);

  const flip = async (key: keyof Settings) => {
    if (!settings) return;
    try { setSettings(await api<Settings>("/learn/settings", { method: "PUT", body: { [key]: !settings[key] } })); } catch (e) { toast.err(e); }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try { await api("/learn/facts", { body: draft }); setDraft({ content: "", category: draft.category }); setAdding(false); toast.ok("Saved"); load(); } catch (e2) { toast.err(e2); }
  };
  const save = async () => {
    if (!editing) return;
    try { await api(`/learn/facts/${editing.id}`, { method: "PUT", body: { content: editing.content } }); setEditing(null); load(); } catch (e) { toast.err(e); }
  };
  const pin = async (f: Fact) => { try { await api(`/learn/facts/${f.id}`, { method: "PUT", body: { pinned: !f.pinned } }); load(); } catch (e) { toast.err(e); } };
  const del = async (f: Fact) => { try { await api(`/learn/facts/${f.id}`, { method: "DELETE" }); toast.ok("Forgotten"); load(); } catch (e) { toast.err(e); } };
  const delLegacy = async (m: Legacy) => { try { await api(`/learn/legacy-memories/${m.id}`, { method: "DELETE" }); load(); } catch (e) { toast.err(e); } };
  const forgetAll = async () => {
    try { await api("/learn/facts/forget-all", { body: {} }); setConfirmAll(false); toast.ok("Everything I learned is gone"); load(); } catch (e) { toast.err(e); }
  };

  return (
    <Page title="What I know about you" kicker="Your assistant" wide className="st-page"
      description="I pick these up as we work so I don't ask twice. Change anything that's wrong, or remove it."
      actions={<Button icon={<Plus size={14} />} onClick={() => setAdding((v) => !v)}>Tell me something</Button>}>
      <div className="st-two">
        <div className="st-stack">
          {adding && (
            <Section title="Something I should know">
              <form className="st-group st-form st-form-pad" onSubmit={add}>
                <Textarea rows={2} autoFocus aria-label="Something I should know" value={draft.content} placeholder="e.g. I'm a solicitor in Brisbane and I bill in 6-minute units"
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
                <div className="st-form-actions">
                  <Select className="st-auto" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} aria-label="Kind">
                    {Object.entries(data?.categories || {}).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                  <Button type="submit" variant="primary" disabled={draft.content.trim().length < 4}>Save</Button>
                  <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
                </div>
              </form>
            </Section>
          )}

          <form className="st-search" role="search" onSubmit={(e) => { e.preventDefault(); load(); }}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search what I know" aria-label="Search what I know" />
            <Button type="submit" icon={<Search size={14} />}>Search</Button>
            {q && <Button variant="ghost" onClick={() => { setQ(""); load(""); }}>Clear</Button>}
          </form>

          {failed && !data ? <ErrorState title="What I know did not load" line={failed} onRetry={() => load()} />
            : !data ? <Loading rows={4} label="Loading what I know" />
            : !groups.length && !data.legacy.length ? (
              <EmptyState icon={<Brain size={22} />} title={q ? "Nothing matches that" : "Nothing yet"}
                line={q ? "Try another word." : "Chat, share a file or show me a task, and what I learn will appear here."} />
            ) : null}

          {groups.map((g) => (
            <Section key={g.key} title={g.label}>
              <ul className="st-group st-list">
                {g.facts.map((f) => (
                  <li key={f.id} className="st-fact">
                    <div className="st-fact-text">
                      {editing?.id === f.id ? (
                        <div className="st-key">
                          <Input autoFocus value={editing.content} aria-label="Edit"
                            onChange={(e) => setEditing({ id: f.id, content: e.target.value })} onKeyDown={(e) => e.key === "Enter" && save()} />
                          <IconButton size="sm" label="Save" onClick={save}><Check size={14} /></IconButton>
                          <IconButton size="sm" label="Cancel" onClick={() => setEditing(null)}><X size={14} /></IconButton>
                        </div>
                      ) : <p>{f.pinned && <Pin size={12} aria-label="Always used" />}{f.content}</p>}
                      <span className="st-item-meta">
                        {sourceLabel(f.source)}{f.evidence ? ` · “${f.evidence.slice(0, 80)}”` : ""} · {relTime(f.updated_at)}{f.uses ? ` · used ${f.uses}×` : ""}
                      </span>
                    </div>
                    <div className="st-fact-actions">
                      <IconButton size="sm" label={f.pinned ? "Only use when relevant" : "Always keep in mind"} onClick={() => pin(f)}>
                        {f.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                      </IconButton>
                      <IconButton size="sm" label="Edit" onClick={() => setEditing({ id: f.id, content: f.content })}><Pencil size={14} /></IconButton>
                      <IconButton size="sm" label="Forget" onClick={() => del(f)}><Trash2 size={14} /></IconButton>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ))}

          {!!data?.legacy.length && (
            <Section title="Things you asked me to remember">
              <ul className="st-group st-list">
                {data.legacy.map((m) => (
                  <li key={m.id} className="st-fact">
                    <div className="st-fact-text"><p>{m.content}</p><span className="st-item-meta">{relTime(m.updated_at)}</span></div>
                    <div className="st-fact-actions"><IconButton size="sm" label="Forget" onClick={() => delLegacy(m)}><Trash2 size={14} /></IconButton></div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {!!data?.facts.length && (
            <div className="st-form-actions">
              {confirmAll ? (
                <>
                  <span className="st-small">Forget everything I've learned about you? This can't be undone.</span>
                  <Button variant="danger" size="sm" onClick={forgetAll}>Yes, forget it all</Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmAll(false)}>Keep</Button>
                </>
              ) : <Button variant="ghost" size="sm" onClick={() => setConfirmAll(true)}>Forget everything</Button>}
            </div>
          )}
        </div>

        <aside className="st-aside" aria-label="Learning">
          <div>
            <h2 className="st-aside-title">Learning</h2>
            <SettingsGroup>
              {SWITCHES.map((s) => (
                <SettingRow key={s.key} label={s.label} help={s.hint}>
                  <Switch checked={!!settings?.[s.key]} disabled={!settings} onChange={() => flip(s.key)} label={s.label} />
                </SettingRow>
              ))}
            </SettingsGroup>
          </div>
          {!!data?.work.length && (
            <div>
              <h2 className="st-aside-title">The work I've seen</h2>
              {data.work.slice(0, 8).map((w) => (
                <div key={w.kind} className="st-work"><span>{w.label.charAt(0).toUpperCase() + w.label.slice(1)}</span><span>{w.times}×</span></div>
              ))}
            </div>
          )}
          {!!lessons.length && (
            <div>
              <h2 className="st-aside-title">Learned from your changes</h2>
              <div className="st-stack">{lessons.slice(0, 6).map((l) => <p key={l.id} className="st-p">{l.lesson}</p>)}</div>
            </div>
          )}
        </aside>
      </div>
    </Page>
  );
}
