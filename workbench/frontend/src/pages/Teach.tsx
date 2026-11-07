import { ArrowLeft, Check, Globe, Mic, Monitor, Pencil, Play, Plus, Square, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { relTime, useToast } from "../util";
import { Badge, Button, Card, EmptyState, IconButton, Input, List, Page, Row, Section, Textarea } from "../ui";
import { Gate, useLoad } from "./agents/kit";
import { Param, Playbook, Run, Step, eventLine, missingValues, runFinished, runLabel, stepParts } from "../learn/text";
import "../learn/learn.css";

type Surface = "browser" | "desktop" | "narration";
type Recorders = Record<Surface, boolean>;
type Recording = { id: number; surface: Surface; status: string; error: string; events: { kind: string; [k: string]: unknown }[] };
type Suggestion = { id: number; title: string; detail: string; cron: string; kind: string };

const SURFACES: { id: Surface; label: string; icon: typeof Globe; hint: string }[] = [
  { id: "browser", label: "On a website", icon: Globe, hint: "A browser window opens. Do the task once, as you normally would." },
  { id: "desktop", label: "On my computer", icon: Monitor, hint: "Do it in your usual apps. I note which apps and windows you use, in order; tell me the clicks and typing in the box as you go." },
  { id: "narration", label: "Just tell me", icon: Mic, hint: "Describe the steps in your own words." },
];

/** "Show me how": watch a task once, turn it into steps the person can check, then repeat it on request or on a schedule. */
export default function Teach() {
  const { id } = useParams();
  return id ? <PlaybookView id={Number(id)} /> : <Home />;
}

function Home() {
  const [recorders, setRecorders] = useState<Recorders | null>(null);
  const [surface, setSurface] = useState<Surface>("browser");
  const [url, setUrl] = useState("");
  const [rec, setRec] = useState<Recording | null>(null);
  const [narration, setNarration] = useState("");
  const [busy, setBusy] = useState(false);
  const items = useLoad(() => api<Playbook[]>("/learn/playbooks"), []);
  const suggestions = useLoad(() => api<Suggestion[]>("/learn/suggestions"), []);
  const nav = useNavigate();
  const toast = useToast();

  const load = () => { items.reload(); suggestions.reload(); };
  useEffect(() => {
    api<Recorders>("/learn/recorders").then((r) => { setRecorders(r); if (!r.browser) setSurface(r.desktop ? "desktop" : "narration"); }).catch(() => {});
  }, []);

  useEffect(() => {  // live view while recording
    if (!rec || rec.status !== "recording") return;
    const t = setInterval(() => api<Recording>(`/learn/recordings/${rec.id}`).then(setRec).catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [rec?.id, rec?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true);
    try { setRec(await api<Recording>("/learn/recordings", { body: { surface, start_url: url } })); } catch (e) { toast.err(e); } finally { setBusy(false); }
  };
  const stop = async () => {
    if (!rec) return;
    setBusy(true);
    try {
      const pb = await api<Playbook>(`/learn/recordings/${rec.id}/stop`, { body: { narration, refine: true } });
      nav(`/teach/${pb.id}`);
    } catch (e) { toast.err(e); } finally { setBusy(false); }
  };
  const accept = async (s: Suggestion) => {
    try { await api(`/learn/suggestions/${s.id}/accept`, { body: {} }); toast.ok("Done. You'll find it under Automations."); load(); } catch (e) { toast.err(e); }
  };
  const dismiss = async (s: Suggestion) => { try { await api(`/learn/suggestions/${s.id}/dismiss`, { body: {} }); load(); } catch (e) { toast.err(e); } };

  const recording = rec && rec.status === "recording";
  return (
    <Page className="ag-page learn-page" kicker="Your assistant" title="Show me how"
      description="Show me a task once. I'll write down the steps, you check them, and next time I do it for you.">
      {(suggestions.data ?? []).map((s) => (
        <Card key={s.id} className="learn-suggest">
          <h3 className="ag-h3">{s.title}</h3>
          <p className="ag-note">{s.detail}</p>
          <div className="ag-bar ag-gap-top">
            <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => accept(s)}>Yes, do it for me</Button>
            <Button size="sm" variant="ghost" onClick={() => dismiss(s)}>No thanks</Button>
          </div>
        </Card>
      ))}

      <Card as="section" className="learn-hero">
        {!recording ? (
          <div className="ag-form">
            <h2 className="ag-title">Teach me something new</h2>
            <div className="learn-choice" role="group" aria-label="Where you'll show me">
              {SURFACES.map((s) => {
                const off = recorders ? !recorders[s.id] : false;
                return (
                  <Button key={s.id} aria-pressed={surface === s.id} className={surface === s.id ? "is-on" : undefined} disabled={off} icon={<s.icon size={14} />}
                    title={off ? (s.id === "desktop" ? "Turn on computer use first (Computer page)" : "Not connected yet") : s.hint} onClick={() => setSurface(s.id)}>
                    {s.label}
                  </Button>
                );
              })}
            </div>
            <p className="ag-note">{SURFACES.find((s) => s.id === surface)?.hint}</p>
            {surface === "browser" && (
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Where does it start? For example xero.com (optional)" aria-label="Start page" />
            )}
            {surface === "narration" && (
              <Textarea rows={5} value={narration} onChange={(e) => setNarration(e.target.value)} aria-label="The steps"
                placeholder={"For example: every Monday I open the timesheet portal.\nI fill in my hours for each day.\nThen I submit it before 5pm."} />
            )}
            <div className="ag-bar">
              {surface === "narration"
                ? <Button variant="primary" busy={busy} disabled={narration.trim().length < 8} onClick={async () => { await start(); }}>Continue</Button>
                : <Button variant="primary" busy={busy} icon={<Play size={14} />} onClick={start}>{busy ? "Opening…" : "Start showing me"}</Button>}
            </div>
          </div>
        ) : (
          <div className="ag-form">
            <h2 className="ag-title learn-watching"><span className="ag-live-dot" aria-hidden="true" />{rec.surface === "narration" ? "Almost there" : "I'm watching"}</h2>
            {rec.surface === "browser" && <p className="ag-note">Do the task in the window that opened. I never record passwords. Press Done when you're finished.</p>}
            {rec.surface === "desktop" && <p className="ag-note">Do the task in your usual apps. I note which app and window you're in (never keystrokes or passwords), so tell me the important clicks below. Press Done when you're finished.</p>}
            {rec.error && <p className="ag-err" role="alert">{rec.error}</p>}
            {rec.surface !== "narration" && (
              <div className="learn-live" aria-live="polite">
                {rec.events.length ? rec.events.slice(-30).map((e, i) => <div key={i}>{eventLine(e as Parameters<typeof eventLine>[0])}</div>) : <div>Waiting for your first step…</div>}
              </div>
            )}
            <Textarea rows={3} value={narration} onChange={(e) => setNarration(e.target.value)} aria-label="Anything to add"
              placeholder="Anything I should know? For example: only chase invoices over 30 days, and be friendly." />
            <div className="ag-bar">
              <Button variant="primary" busy={busy} icon={<Square size={14} />} onClick={stop}>{busy ? "Writing it up…" : "Done"}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setRec(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </Card>

      <Section title="Things you've shown me">
        <Gate state={items} rows={3}>{(list) => !list.length
          ? <EmptyState title="Nothing yet" line="When you show me a task it appears here, ready to repeat." />
          : <List className="ag-list" label="Things you've shown me">
            {list.map((p) => (
              <Row key={p.id} title={p.name} onClick={() => nav(`/teach/${p.id}`)}
                meta={`${p.steps.length} steps · ${p.runs ? `done ${p.runs}×` : "not run yet"} · ${p.status === "draft" ? "needs your check" : "ready"} · ${relTime(p.updated_at)}`}
                actions={<Badge>{p.surface === "desktop" ? "Computer" : p.surface === "browser" ? "Website" : "Described"}</Badge>} />
            ))}
          </List>}
        </Gate>
      </Section>
    </Page>
  );
}

function PlaybookView({ id }: { id: number }) {
  const book = useLoad(() => api<Playbook & { runs_list: Run[]; last_values: Record<string, string> }>(`/learn/playbooks/${id}`).then((p) => {
    setValues((v) => (Object.keys(v).length ? v : Object.fromEntries(p.params.map((x: Param) => [x.name, p.last_values[x.name] || x.example || ""]))));
    return p;
  }), [id]);
  const pb = book.data;
  const [edit, setEdit] = useState<{ name: string; steps: Step[] } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [run, setRun] = useState<Run | null>(null);
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const timer = useRef<ReturnType<typeof setInterval>>();
  const nav = useNavigate();
  const toast = useToast();

  const load = book.reload;
  useEffect(() => () => clearInterval(timer.current), []);

  const save = async (ready = false) => {
    if (!pb) return;
    try {
      const body = edit ? { name: edit.name, steps: edit.steps.filter((s) => s.text.trim()), ready } : { ready };
      const r = await api<Playbook & { note: string }>(`/learn/playbooks/${id}`, { method: "PUT", body });
      if (r.note) setNote(r.note);
      setEdit(null);
      toast.ok(ready ? "Saved. I'm ready to do this." : "Saved");
      load();
    } catch (e) { toast.err(e); }
  };
  const go = async () => {
    if (!pb) return;
    const missing = missingValues(pb.params, values);
    if (missing.length) return toast.err(`Tell me: ${missing.map((m) => m.label).join(", ")}`);
    try {
      const r = await api<Run>(`/learn/playbooks/${id}/run`, { body: { values } });
      setRun(r);
      clearInterval(timer.current);
      timer.current = setInterval(async () => {
        const s = await api<Run>(`/learn/runs/${r.id}`).catch(() => null);
        if (s) setRun(s);
        if (!s || runFinished(s.status)) { clearInterval(timer.current); load(); }
      }, 2000);
    } catch (e) { toast.err(e); }
  };
  const rate = async (rating: number) => {
    if (!run) return;
    try {
      const r = await api<{ note: string }>("/learn/feedback", { body: { target_kind: "run", target_id: String(run.id), rating, comment } });
      setNote(r.note || (rating > 0 ? "Thanks. I'll keep doing it this way." : ""));
      setComment("");
    } catch (e) { toast.err(e); }
  };
  const remove = async () => { try { await api(`/learn/playbooks/${id}`, { method: "DELETE" }); nav("/teach"); } catch (e) { toast.err(e); } };

  const back = <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={() => nav("/teach")}>Show me how</Button>;
  if (!pb) return (
    <Page className="ag-page learn-page" title="Show me how" kicker="Steps">
      <div className="ag-stack">{back}<Gate state={book} rows={4} title="That did not open">{() => null}</Gate></div>
    </Page>
  );
  const steps = edit ? edit.steps : pb.steps;
  return (
    <Page className="ag-page learn-page" kicker={pb.status === "draft" ? "Check these steps" : `Done ${pb.runs}× · worked ${pb.successes}×`}
      title={pb.name} description={pb.summary}
      actions={<>{back}{!edit && <Button icon={<Pencil size={14} />} onClick={() => setEdit({ name: pb.name, steps: pb.steps.map((s) => ({ ...s })) })}>Change steps</Button>}</>}>
      {edit && <Input label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}
      {note && <p className="learn-note" role="status">{note}</p>}

      <Section title="Steps">
        <ol className="learn-steps">
          {steps.map((s, i) => (
            <li key={i}>
              <div className="ag-grow">
                {edit ? (
                  <Input value={s.text} aria-label={`Step ${i + 1}`}
                    onChange={(e) => setEdit({ ...edit, steps: edit.steps.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
                ) : (
                  <span>
                    {stepParts(s.text, values).map((p, k) => (p.param ? <span key={k} className="param">{p.text}</span> : <span key={k}>{p.text}</span>))}
                    {s.sensitive && <Badge tone="warn" className="learn-flag">I'll ask first</Badge>}
                    {s.needs_user && <Badge className="learn-flag">You do this</Badge>}
                  </span>
                )}
              </div>
              {edit && <IconButton size="sm" label="Remove step" onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_, j) => j !== i) })}><X size={14} /></IconButton>}
            </li>
          ))}
        </ol>
        {edit && (
          <div className="ag-bar ag-gap-top">
            <Button variant="ghost" size="sm" icon={<Plus size={14} />} onClick={() => setEdit({ ...edit, steps: [...edit.steps, { action: "note", text: "" }] })}>Add a step</Button>
            <span className="ag-bar-end">
              <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
              <Button variant="primary" icon={<Check size={14} />} onClick={() => save(true)}>Save</Button>
            </span>
          </div>
        )}
        {!edit && !!pb.notes.length && <p className="ag-note ag-gap-top">What I've learned: {pb.notes.slice(-4).join(" · ")}</p>}
      </Section>

      {!edit && (
        <Section title="Do it now">
          {!!pb.params.length && (
            <div className="ag-form-row">
              {pb.params.map((p) => (
                <Input key={p.name} label={p.label} value={values[p.name] || ""} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} />
              ))}
            </div>
          )}
          <div className="ag-bar ag-gap-top">
            {pb.status === "draft" && <Button icon={<Check size={14} />} onClick={() => save(true)}>Looks right</Button>}
            <Button variant="primary" icon={<Play size={14} />} onClick={go} disabled={!!run && !runFinished(run.status)}>Do it for me</Button>
            <Button onClick={async () => {
              try {
                const r = await api<{ already: boolean }>(`/learn/playbooks/${id}/each-morning`, { method: "POST" });
                toast.ok(r.already ? "Already checking this each morning." : "I'll check this on weekday mornings and tell you what changed.");
                load();
              } catch (e) { toast.err(e); }
            }}>{pb.schedule_id ? "Checking each morning" : "Check this each morning"}</Button>
            <span className="ag-bar-end"><Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={remove}>Delete</Button></span>
          </div>
          {run && (
            <div className="ag-panel ag-gap-top ag-stack" aria-live="polite">
              <strong>{runLabel(run.status)}</strong>
              {run.status === "needs_you" && <p className="ag-note">I've stopped before anything goes out. Check the browser window and approve it there.</p>}
              {run.result && <p className="ag-body">{run.result}</p>}
              {runFinished(run.status) && (
                <div className="ag-stack">
                  <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Anything to do differently next time?" aria-label="Feedback" />
                  <div className="ag-bar">
                    <Button size="sm" icon={<ThumbsUp size={14} />} onClick={() => rate(1)}>Good</Button>
                    <Button size="sm" icon={<ThumbsDown size={14} />} onClick={() => rate(-1)}>Not quite</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </Section>
      )}
    </Page>
  );
}
