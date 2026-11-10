/**
 * Meeting companion (feat/v02-anywhere-voice; Pro). Record a meeting (your microphone, plus the computer's sound so the
 * other people on a call are heard too) or bring in a recording or a transcript from Zoom, Teams or Meet. You get notes,
 * decisions, and action items with owners and dates; the actions can go into Tasks, and the follow-up email is saved as
 * a draft for you to check and send yourself. Nothing is ever sent, and recording starts only after the consent notice.
 */
import { Check, CheckSquare, Circle, Copy, FileUp, Mail, Mic, NotebookPen, Square, Trash2, Users } from "lucide-react";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { ModelSelect, relTime, useModels, useToast } from "../util";
import { Button, Card, EmptyState, ErrorState, IconButton, Input, List, Loading, Page, Row, Section, Select, Sheet, Textarea } from "../ui";
import { Split, StatusText, plainError } from "./agents/kit";
import { extFor, mimeType } from "../voice/engine";
import { Action, actionMeta, clock, notesText } from "../voice/logic";
import "../voice/voice.css";

/** A meeting from the work calendar (design 0012); online: it was held in Teams or Google Meet, so it can have a transcript. */
type TeamsMeeting = { event: string; title: string; start: string; online: boolean };

type Notes = { summary: string; notes: string[]; decisions: string[]; actions: Action[]; attendees: string[]; follow_up: { subject: string; body: string }; template?: string };
type Seg = { start: number; end: number; speaker: string; text: string };
type Meeting = {
  id: number; title: string; source: "recording" | "audio" | "transcript"; status: "recording" | "ready" | "summarised"; consent_at: string | null;
  project: string; seconds: number; created_at: string; updated_at: string; notes: Notes | null; segments?: Seg[]; transcript?: string; preview?: string;
};

const CHUNK_MS = 30_000;

/** Mic + (when allowed) the computer's sound, mixed into one stream. */
async function openSources(systemAudio: boolean): Promise<{ stream: MediaStream; system: boolean; close: () => void }> {
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  let screen: MediaStream | null = null;
  if (systemAudio && navigator.mediaDevices.getDisplayMedia) {
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      screen.getVideoTracks().forEach((t) => t.stop()); // only the sound is used
      if (!screen.getAudioTracks().length) { screen = null; }
    } catch { screen = null; }
  }
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(mic).connect(dest);
  if (screen) ctx.createMediaStreamSource(new MediaStream(screen.getAudioTracks())).connect(dest);
  return {
    stream: dest.stream, system: !!screen,
    close: () => { mic.getTracks().forEach((t) => t.stop()); screen?.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => undefined); },
  };
}

async function upload(path: string, blob: Blob) {
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", headers: { "X-Workbench": "1", "Content-Type": blob.type || "application/octet-stream" }, body: blob });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.detail || `${res.status}`);
  return body;
}

/** Recording the computer's sound needs screen sharing with sound, which the Rooks app's webview (WebKit) and some
 *  browsers do not have. Then only the microphone is offered, and the page says why. */
export const canShareSound = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
export const NO_SOUND = "Recording the computer's sound needs Chrome. The microphone works.";

function ConsentModal({ onStart, onClose }: { onStart: (title: string, system: boolean) => void; onClose: () => void }) {
  const [told, setTold] = useState(false);
  const [title, setTitle] = useState("");
  const sound = canShareSound();
  const [system, setSystem] = useState(sound);
  return (
    <Sheet open onClose={onClose} title="Before you record" width={480}
      footer={<div className="ag-bar"><span className="ag-bar-end"><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={<Mic size={14} />} disabled={!told} onClick={() => onStart(title, system)}>Start recording</Button></span></div>}>
      <div className="ag-form">
        <p className="ag-body">Tell everyone in the meeting that you're recording and taking notes, and give them the chance to say no. In many places it's the law to ask first.</p>
        <Input label="Meeting name" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example Weekly catch-up" autoFocus />
        {sound ? (
          <label className="ag-check"><input type="checkbox" checked={system} onChange={(e) => setSystem(e.target.checked)} />
            <span>Also record the computer's sound, so I hear the other people on a video call<small>You'll be asked to share a screen or tab with sound.</small></span></label>
        ) : <p className="ag-note" role="note">{NO_SOUND}</p>}
        <label className="ag-check consent-check"><input type="checkbox" checked={told} onChange={(e) => setTold(e.target.checked)} /> <b>I've told everyone this meeting is being recorded</b></label>
        <p className="ag-note">The sound is turned into text as we go and then thrown away. Only the transcript and notes are kept, on this computer.</p>
      </div>
    </Sheet>
  );
}

function Recorder({ meeting, system, onDone }: { meeting: Meeting; system: boolean; onDone: (m: Meeting) => void }) {
  const [elapsed, setElapsed] = useState(0);
  const [lines, setLines] = useState<Seg[]>([]);
  const [pending, setPending] = useState(0);
  const [note, setNote] = useState("");
  const [stopping, setStopping] = useState(false);
  const toast = useToast();
  const live = useRef(true);
  const uploads = useRef<Promise<unknown>[]>([]);
  const stopFn = useRef<() => void>(() => undefined);

  useEffect(() => {
    let sources: Awaited<ReturnType<typeof openSources>> | null = null;
    let rec: MediaRecorder | null = null;
    let segStart = 0;
    const began = Date.now();
    const tick = setInterval(() => setElapsed((Date.now() - began) / 1000), 500);
    const mime = mimeType();

    const send = (blob: Blob, offset: number) => {
      if (!blob.size) return;
      setPending((n) => n + 1);
      const p = upload(`/meetings/${meeting.id}/chunk?offset=${offset.toFixed(2)}&name=chunk.${extFor(blob.type || mime)}`, blob)
        .then((r: { added: Seg[] }) => setLines((l) => [...l, ...(r.added || [])]))
        .catch((e) => toast.err(e))
        .finally(() => setPending((n) => n - 1));
      uploads.current.push(p);
    };
    // A new recorder every 30 seconds, so each piece is a complete file the speech model can read on its own
    const next = () => {
      if (!live.current || !sources) return;
      const chunks: Blob[] = [];
      const offset = segStart;
      rec = new MediaRecorder(sources.stream, mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => { send(new Blob(chunks, { type: rec?.mimeType || mime }), offset); if (live.current) next(); };
      rec.start();
      setTimeout(() => { segStart = (Date.now() - began) / 1000; if (rec && rec.state !== "inactive") rec.stop(); }, CHUNK_MS);
    };
    stopFn.current = () => { live.current = false; if (rec && rec.state !== "inactive") rec.stop(); };

    openSources(system).then((s) => {
      sources = s;
      setNote(system && !s.system ? "Only your microphone is being recorded (the computer's sound wasn't shared). On a call, use speakers so I can hear the others too." : "");
      next();
    }).catch(() => { toast.err("Microphone access is off. Allow it in your system settings, then try again."); live.current = false; });

    return () => { live.current = false; clearInterval(tick); if (rec && rec.state !== "inactive") rec.stop(); setTimeout(() => sources?.close(), 300); };
  }, [meeting.id]);

  const stop = async () => {
    setStopping(true);
    stopFn.current();
    await new Promise((r) => setTimeout(r, 400));
    await Promise.allSettled(uploads.current);
    try { onDone(await api<Meeting>(`/meetings/${meeting.id}/stop`, { method: "POST" })); } catch (e) { toast.err(e); setStopping(false); }
  };

  return (
    <div className="ag-stack-lg">
      <Card className="recorder">
        <span className="rec-dot" aria-hidden="true" />
        <div className="ag-grow">
          <div className="recorder-time">{clock(elapsed)}</div>
          <p className="ag-note">Recording “{meeting.title}”. Everyone should know.{pending > 0 ? ` Writing down the last ${pending * 30} seconds…` : ""}</p>
        </div>
        <Button variant="primary" icon={<Square size={14} />} onClick={stop} busy={stopping}>{stopping ? "Writing the notes…" : "Stop and write notes"}</Button>
      </Card>
      {note && <p className="ag-note mt-note" role="status">{note}</p>}
      <Section title="Live transcript">
        <div className="transcript-live" aria-live="polite">
          {lines.length === 0 ? <p className="ag-note">The first lines appear about half a minute in.</p>
            : lines.map((l, i) => <p key={i} className="mt-line"><span className="mt-time">{clock(l.start)}</span> {l.text}</p>)}
        </div>
      </Section>
    </div>
  );
}

function Detail({ m, onChange, onDelete }: { m: Meeting; onChange: (m: Meeting) => void; onDelete: () => void }) {
  const [busy, setBusy] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [project, setProject] = useState(m.project);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState(m.notes?.follow_up.subject ?? "");
  const [body, setBody] = useState(m.notes?.follow_up.body ?? "");
  const [draftSaved, setDraftSaved] = useState(false);
  const [showT, setShowT] = useState(!m.notes);
  const [model, setModel] = useState("");
  const [template, setTemplate] = useState(m.notes?.template ?? "general");
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const { models } = useModels();
  const toast = useToast();
  const n = m.notes;

  useEffect(() => { api<{ id: string; name: string }[]>("/meetings/templates").then(setTemplates).catch(() => setTemplates([])); }, []);
  useEffect(() => {
    setTemplate(m.notes?.template ?? "general");
    setSubject(m.notes?.follow_up.subject ?? ""); setBody(m.notes?.follow_up.body ?? ""); setProject(m.project);
    setPicked(new Set((m.notes?.actions ?? []).map((a, i) => (a.task_id ? -1 : i)).filter((i) => i >= 0)));
    setDraftSaved(false);
  }, [m.id, m.notes]);

  const summarise = async () => {
    setBusy("notes");
    try { onChange(await api<Meeting>(`/meetings/${m.id}/summarise`, { body: { model: model || null, template } })); setShowT(false); } catch (e) { toast.err(e); }
    setBusy("");
  };
  const addTasks = async () => {
    setBusy("tasks");
    try {
      const r = await api<{ created: number[]; project: string }>(`/meetings/${m.id}/tasks`, { body: { indexes: [...picked], project } });
      onChange(await api<Meeting>(`/meetings/${m.id}`));
      toast.ok(r.created.length ? `Added ${r.created.length} to Tasks${r.project ? ` under ${r.project}` : ""}` : "Those are already in Tasks");
    } catch (e) { toast.err(e); }
    setBusy("");
  };
  const saveDraft = async () => {
    setBusy("draft");
    try {
      await api(`/meetings/${m.id}/draft`, { body: { to, subject, body } });
      setDraftSaved(true);
      toast.ok("Saved to your drafts. Nothing was sent.");
    } catch (e) { toast.err(e); }
    setBusy("");
  };
  const rename = async (title: string) => {
    if (title.trim() && title !== m.title) { try { onChange(await api<Meeting>(`/meetings/${m.id}`, { method: "PATCH", body: { title } })); } catch (e) { toast.err(e); } }
  };

  const templatePick = templates.length > 1 && (
    <Select className="mt-template" value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Kind of meeting">
      {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </Select>
  );

  return (
    <div className="ag-stack-lg">
      <div className="ag-bar">
        <input className="ui-input meeting-title ag-grow" defaultValue={m.title} key={m.id} onBlur={(e) => rename(e.target.value)} aria-label="Meeting name" />
        <span className="ag-meta">{m.source === "recording" ? "Recorded" : m.source === "audio" ? "From a recording" : "From a transcript"} · {relTime(m.created_at)}{m.seconds ? ` · ${clock(m.seconds)}` : ""}</span>
        <IconButton size="sm" label="Delete meeting" onClick={onDelete}><Trash2 size={14} /></IconButton>
      </div>

      {!n ? (
        <Card className="ag-form">
          <p className="ag-note">Ready to write the notes: a summary, what was decided, and who's doing what by when.</p>
          <div className="ag-bar"><div className="rs-model"><ModelSelect value={model} onChange={setModel} models={models} /></div>
            {templatePick}
            <Button variant="primary" icon={<NotebookPen size={14} />} onClick={summarise} busy={busy === "notes"} disabled={!!busy && busy !== "notes"}>{busy === "notes" ? "Writing the notes…" : "Write the notes"}</Button></div>
        </Card>
      ) : (
        <>
          <Section title="Summary" actions={<>
            <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => navigator.clipboard.writeText(notesText(m.title, n)).then(() => toast.ok("Notes copied"))}>Copy notes</Button>
            {templatePick}
            <Button size="sm" variant="ghost" onClick={summarise} busy={busy === "notes"} disabled={!!busy && busy !== "notes"}>{busy === "notes" ? "Writing…" : "Write again"}</Button></>}>
            <div className="ag-stack">
              <p className="ag-body">{n.summary}</p>
              {n.attendees.length > 0 && <p className="ag-meta ag-bar"><Users size={14} aria-hidden="true" /> {n.attendees.join(", ")}</p>}
              {n.notes.length > 0 && <><p className="ag-label">Notes</p><ul className="meeting-list">{n.notes.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
              {n.decisions.length > 0 && <><p className="ag-label">Decisions</p><ul className="meeting-list decisions">{n.decisions.map((x, i) => <li key={i}><Check size={14} aria-hidden="true" /> {x}</li>)}</ul></>}
            </div>
          </Section>

          <Section title="Action items">
            {n.actions.length === 0 ? <p className="ag-note">No action items came up.</p> : (
              <div className="ag-stack">
                <div>
                  {n.actions.map((a, i) => (
                    <label key={i} className={`action-item ${a.task_id ? "added" : ""}`}>
                      {a.task_id ? <Check size={16} className="ok" aria-label="In Tasks" /> :
                        <input type="checkbox" checked={picked.has(i)} onChange={(e) => setPicked((p) => { const q = new Set(p); if (e.target.checked) q.add(i); else q.delete(i); return q; })} />}
                      <span className="ag-grow"><span>{a.task}</span><span className="ag-meta action-meta">{actionMeta(a)}</span></span>
                    </label>
                  ))}
                </div>
                <div className="ag-bar">
                  <div className="mt-project"><Input placeholder="Project (optional)" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" /></div>
                  <Button size="sm" variant="primary" icon={<CheckSquare size={14} />} onClick={addTasks} busy={busy === "tasks"} disabled={(!!busy && busy !== "tasks") || picked.size === 0}>{busy === "tasks" ? "Adding…" : `Add ${picked.size || ""} to Tasks`}</Button>
                  <Link className="ag-meta" to="/tasks">Open Tasks</Link>
                </div>
              </div>
            )}
          </Section>

          <Section title="Follow-up email" description="I'll save this as a draft. I never send it: check it, then send it yourself from your mail.">
            <div className="ag-form">
              <Input placeholder={n.attendees.length ? `To (for example the emails for ${n.attendees.slice(0, 2).join(", ")})` : "To (email addresses)"} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
              <Textarea rows={9} value={body} onChange={(e) => { setBody(e.target.value); setDraftSaved(false); }} aria-label="Email" />
              <div className="ag-bar">
                <Button size="sm" variant="primary" icon={<Mail size={14} />} onClick={saveDraft} busy={busy === "draft"} disabled={(!!busy && busy !== "draft") || !body.trim()}>{busy === "draft" ? "Saving…" : "Save as draft"}</Button>
                {draftSaved && <span className="ag-meta ag-ok"><Check size={14} aria-hidden="true" /> Saved in Mail, Drafts (and your Gmail or Outlook drafts if connected). Not sent.</span>}
                {draftSaved && <Link className="ag-meta" to="/mail">Open Mail</Link>}
              </div>
            </div>
          </Section>
        </>
      )}

      <Section title="Transcript" actions={<Button size="sm" variant="ghost" onClick={() => setShowT((s) => !s)} aria-expanded={showT}>{showT ? "Hide" : "Show"}</Button>}>
        {showT && <div className="transcript">{(m.segments ?? []).length === 0 ? <p className="ag-note">No transcript yet.</p> : (m.segments ?? []).map((s, i) => (
          <p key={i} className="mt-line"><span className="mt-time">{clock(s.start)}</span> {s.speaker && <b>{s.speaker}: </b>}{s.text}</p>
        ))}</div>}
      </Section>
    </div>
  );
}

export default function Meetings() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [list, setList] = useState<Meeting[] | null>(null);
  const [listErr, setListErr] = useState<unknown>(null);
  const [openErr, setOpenErr] = useState<unknown>(null);
  const [again, setAgain] = useState(0);
  const [locked, setLocked] = useState("");
  const [current, setCurrent] = useState<Meeting | null>(null);
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState<{ m: Meeting; system: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [teams, setTeams] = useState<TeamsMeeting[] | null>(null);  // design 0012: null while work transcripts are off
  const [place, setPlace] = useState("Teams");  // the work account's own word: Teams or Google Meet
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [fetching, setFetching] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const mid = id ? Number(id) : null;

  const load = () => api<Meeting[]>("/meetings").then((l) => { setList(l); setListErr(null); })
    .catch((e) => { if (e instanceof ApiError && e.status === 402) { setLocked(e.message); setList([]); } else setListErr(e); });
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api<{ meetings: TeamsMeeting[]; place?: string }>("/work/meetings").then((r) => { setTeams(r.meetings); if (r.place) setPlace(r.place); }).catch(() => setTeams(null)); }, []);
  const fromTeams = async (t: TeamsMeeting) => {
    setFetching(t.event);
    try {
      const r = await api<{ meeting_id: number }>("/work/transcript", { body: { event: t.event } });
      setTeamsOpen(false); await load(); navigate(`/meetings/${r.meeting_id}`);
      toast.ok(`Brought in from ${place}. Now write the notes.`);
    } catch (e) { toast.err(e); }
    setFetching("");
  };
  useEffect(() => {
    setOpenErr(null);
    if (!mid) return setCurrent(null);
    api<Meeting>(`/meetings/${mid}`).then(setCurrent).catch(setOpenErr);
  }, [mid, again]);

  const start = async (title: string, system: boolean) => {
    setConsent(false);
    try {
      const m = await api<Meeting>("/meetings", { body: { title, consent: true } });
      setRecording({ m, system });
      navigate(`/meetings/${m.id}`);
      load();
    } catch (e) { toast.err(e); }
  };
  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setImporting(true);
    try {
      const m = await upload(`/meetings/import?name=${encodeURIComponent(f.name)}`, f) as Meeting;
      await load();
      navigate(`/meetings/${m.id}`);
      toast.ok("Brought in. Now write the notes.");
    } catch (err) { toast.err(err); }
    setImporting(false);
  };
  const remove = async () => {
    if (!current || !confirm(`Delete “${current.title}” and its notes? Tasks already added stay in Tasks.`)) return;
    try { await api(`/meetings/${current.id}`, { method: "DELETE" }); } catch (e) { toast.err(e); return; }
    navigate("/meetings");
    load();
  };

  const desc = "Record a meeting or bring in a file. I write the notes, list who's doing what by when, and draft the follow-up email for you to send.";
  if (locked) {
    return (
      <Page className="ag-page" title="Meetings" description={desc}>
        <EmptyState icon={<Users size={20} />} title="The meeting companion is part of Pro" line="Record or bring in a meeting and get notes, decisions, action items and a follow-up email draft." />
      </Page>
    );
  }

  const isRecording = recording && recording.m.id === mid;
  return (
    <Page wide className="ag-page mt-page" title={current?.title && mid ? current.title : "Meetings"} kicker={mid ? "Meetings" : undefined} description={mid ? undefined : desc}
      actions={<>
        <Button variant="primary" icon={<Circle size={12} fill="currentColor" />} onClick={() => setConsent(true)} disabled={!!recording}>Record</Button>
        <Button icon={<FileUp size={14} />} onClick={() => file.current?.click()} busy={importing}>{importing ? "Bringing it in…" : "Bring in a file"}</Button>
        {teams !== null && <Button icon={<Users size={14} />} onClick={() => setTeamsOpen(true)}>From {place}</Button>}
        <input ref={file} type="file" hidden accept=".vtt,.srt,.txt,.md,.json,.docx,audio/*,video/*,.m4a,.mp3,.wav,.webm,.mp4" onChange={onImport} />
      </>}>
      <Split solo={!mid && list?.length === 0} list={
        list === null ? (listErr ? <ErrorState title="Your meetings did not load" line={plainError(listErr)} onRetry={load} /> : <Loading rows={4} />)
          : list.length === 0 ? <EmptyState icon={<Users size={20} />} title="No meetings yet" line="Record one, or bring in a recording or a transcript from Zoom, Teams or Meet." />
          : <List className="ag-list" label="Meetings">
            {list.map((m) => (
              <Row key={m.id} active={m.id === mid} onClick={() => navigate(`/meetings/${m.id}`)} title={m.title}
                meta={<StatusText live={m.status === "recording"}>{relTime(m.created_at)} · {m.status === "summarised" ? "Notes ready" : m.status === "recording" ? "Recording" : "Needs notes"}</StatusText>} />
            ))}
          </List>
      }>
        {isRecording ? <Recorder meeting={recording.m} system={recording.system} onDone={(m) => { setRecording(null); setCurrent(m); load(); }} />
          : current ? <Detail m={current} onChange={(m) => { setCurrent(m); load(); }} onDelete={remove} />
          : mid && openErr ? <ErrorState title="That meeting did not open" line={plainError(openErr)} onRetry={() => setAgain((n) => n + 1)} />
          : mid ? <Loading rows={4} />
          : <Card><EmptyState icon={<Users size={20} />} title={list?.length === 0 ? "No meetings yet" : "Your meeting companion"} line="Record a meeting or bring in a file, and I'll write the notes."
              action={<Button variant="primary" icon={<Mic size={14} />} onClick={() => setConsent(true)}>Record a meeting</Button>} /></Card>}
      </Split>
      {consent && <ConsentModal onStart={start} onClose={() => setConsent(false)} />}
      <Sheet open={teamsOpen} onClose={() => setTeamsOpen(false)} title={`Meetings in ${place}`}>
        {teams && teams.filter((t) => t.online).length === 0 && <p className="mt-line">No {place} meetings in the last two weeks.</p>}
        {teams && teams.filter((t) => t.online).length > 0 && (
          <List label={`${place} meetings`}>
            {teams.filter((t) => t.online).map((t) => (
              <Row key={t.event} title={t.title} meta={t.start ? t.start.slice(0, 16).replace("T", " ") : ""}
                actions={<Button size="sm" busy={fetching === t.event} onClick={() => void fromTeams(t)}>{`Get the transcript from ${place}`}</Button>} />
            ))}
          </List>
        )}
        <p className="mt-line">Only meetings that were transcribed in {place} have one. Reading it needs no yes; nothing is sent.</p>
      </Sheet>
    </Page>
  );
}
