// Coworkers: pick a line of work, review the proposed team, connect what it needs, approve its jobs
// (feat/coworkers, docs/design/0004-coworkers.md). Everything here is real state from /api/starters and Needs you.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api";
import { useToast } from "../util";
import { Advanced } from "./settings/index";
import { ApprovalCard, Badge, Button, Card, Chip, EmptyState, ErrorState, Input, Loading, Page, Section } from "../ui";
import { plainError } from "./agents/kit";
import ConnectMailCalendar from "./ConnectMailCalendar";
import { proposalChoices, type Proposal, type SetupView } from "./coworkersLogic";
import "./coworkers.css";

type Profession = { id: string; label: string; blurb: string; set_up: boolean };

export default function Coworkers() {
  const [params] = useSearchParams();
  const [list, setList] = useState<Profession[] | null>(null);
  const [setups, setSetups] = useState<SetupView[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [picked, setPicked] = useState<string[]>(() => (params.get("pick") ?? "").split(",").filter(Boolean));
  const [region, setRegion] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState("");
  const toast = useToast();

  const load = async () => {
    try {
      const r = await api<{ professions: Profession[] }>("/starters");
      setList(r.professions);
      setSetups(await Promise.all(r.professions.filter((p) => p.set_up).map((p) => api<SetupView>(`/starters/${p.id}`))));
      setErr(null);
    } catch (e) { setErr(e); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {  // arriving from the first run with a choice already made: show the proposal straight away
    if (list && picked.length && !proposal) void propose(picked.filter((id) => list.some((p) => p.id === id && !p.set_up)));
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  const propose = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy("propose");
    try { setProposal(await api<Proposal>("/starters/proposal", { body: { professions: ids, region } })); }
    catch (e) { toast.err(e); }
    setBusy("");
  };

  const create = async () => {
    if (!proposal) return;
    setBusy("create");
    try {
      for (const body of proposalChoices(proposal)) await api("/starters/apply", { body });
      toast.ok("Your team is ready. Each job waits for your OK before it runs.");
      setProposal(null); setPicked([]);
      await load();
    } catch (e) { toast.err(e); }
    setBusy("");
  };

  const answer = async (scheduleId: number, yes: boolean) => {
    setBusy(`s${scheduleId}`);
    try {
      await api(`/needs-you/s:${scheduleId}/${yes ? "approve" : "deny"}`, { method: "POST" });
      toast.ok(yes ? "Turned on. It runs at the next time shown." : "Removed. Nothing else changed.");
      await load();
    } catch (e) { toast.err(e); }
    setBusy("");
  };

  const remove = async (s: SetupView) => {
    setBusy(`rm-${s.profession}`);
    try {
      await api(`/starters/${s.profession}`, { method: "DELETE" });
      toast.ok(`${s.label} removed. Your mail, tasks, drafts and chats are kept.`);
      await load();
    } catch (e) { toast.err(e); }
    setBusy("");
  };

  const needsMail = useMemo(() => setups.some((s) => s.schedules.some((j) => j.missing.length)), [setups]);
  const open = (list ?? []).filter((p) => !p.set_up);

  return (
    <Page wide className="cw-page" kicker="Your work" title="Coworkers"
      description="A small team for the work you do. They only run when a job you turned on comes due, and anything that sends or changes something outside the app waits for your OK.">
      {err && !list ? <ErrorState title="Your team did not load" line={plainError(err)} onRetry={load} />
        : !list ? <Loading rows={3} />
        : <>
          {setups.map((s) => (
            <Section key={s.profession} title={s.label} description={s.region ? `For a business in ${s.region}.` : undefined}
              actions={<Button variant="ghost" size="sm" icon={<Trash2 size={14} />} busy={busy === `rm-${s.profession}`}
                onClick={() => void remove(s)}>Remove</Button>}>
              <ul className="cw-team" aria-label="Team">
                {s.team.map((a) => (
                  <li key={a.id} className="cw-member">
                    <span className="cw-name">{a.name}</span>
                    <span className="cw-role">{a.title}</span>
                    {a.status !== "active" && <Badge tone="warn">Paused</Badge>}
                  </li>
                ))}
              </ul>
              <div className="cw-jobs">
                {s.schedules.map((j) => j.state === "waiting" && j.missing.length ? (
                  <Card key={j.schedule_id} className="cw-job">
                    <div className="cw-between"><strong>{j.card.action}</strong><Badge tone="warn">Not ready</Badge></div>
                    <p className="cw-line">{j.card.requester} will run this once you connect what it needs.</p>
                    <p className="cw-meta cw-warn">{j.missing.join(" ")}</p>
                    <div className="cw-actions">
                      <Button variant="ghost" size="sm" busy={busy === `s${j.schedule_id}`} onClick={() => void answer(j.schedule_id, false)}>Not now</Button>
                    </div>
                  </Card>
                ) : j.state === "waiting" ? (
                  <ApprovalCard key={j.schedule_id} effect="schedule" busy={busy === `s${j.schedule_id}`}
                    title={`${j.card.requester} asks to run ${j.card.action}`}
                    detail={`Reads: ${j.card.reads} Changes: ${j.card.changes} You get: ${j.card.result} ${j.card.risks}`}
                    onApprove={() => void answer(j.schedule_id, true)} onDeny={() => void answer(j.schedule_id, false)} />
                ) : (
                  <Card key={j.schedule_id} className="cw-job">
                    <div className="cw-between">
                      <strong>{j.name}</strong>
                      <Badge tone={j.state === "on" ? "ok" : "neutral"}>{j.state === "on" ? "On" : "Off"}</Badge>
                    </div>
                    <p className="cw-line">{j.card.when ?? j.card.action}</p>
                    <p className="cw-meta">
                      {j.last_run ? `Last run ${new Date(j.last_run).toLocaleString()}: ${j.last_status === "ok" ? "done" : j.last_status === "waiting" ? "a step is waiting for your OK" : "it did not finish"}.` : "Not run yet."}
                      {j.next_run && ` Next ${new Date(j.next_run).toLocaleString()}.`}
                    </p>
                  </Card>
                ))}
              </div>
            </Section>
          ))}

          {needsMail && (
            <Section title="Connect your email" description="These jobs read your inbox. Connect it once; drafts are saved there and nothing is sent without you.">
              <ConnectMailCalendar title="Your email" onChange={() => void load()} />
            </Section>
          )}

          {!proposal && open.length > 0 && (
            <Section title={setups.length ? "Add another team" : "What do you do?"}
              description="Pick one or more. You can change this later without losing anything else.">
              <div className="cw-picks" role="group" aria-label="Lines of work">
                {open.map((p) => (
                  <Chip key={p.id} active={picked.includes(p.id)} title={p.blurb}
                    onClick={() => setPicked((x) => x.includes(p.id) ? x.filter((i) => i !== p.id) : [...x, p.id])}>{p.label}</Chip>
                ))}
              </div>
              <Input label="Where you work (optional)" hint="Only used as context. Local rules are never assumed from it."
                value={region} maxLength={80} onChange={(e) => setRegion(e.target.value)} placeholder="Brisbane" />
              <div className="cw-actions">
                <Button variant="primary" disabled={!picked.length} busy={busy === "propose"} onClick={() => void propose(picked)}>See the team</Button>
              </div>
            </Section>
          )}

          {proposal && <ProposalView proposal={proposal} onChange={setProposal} busy={busy === "create"}
            onCreate={() => void create()} onCancel={() => setProposal(null)} />}

          {!open.length && !setups.length && <EmptyState title="Nothing to set up" line="Every line of work in the list is already set up." />}
        </>}
    </Page>
  );
}

function ProposalView({ proposal, onChange, onCreate, onCancel, busy }: {
  proposal: Proposal; onChange: (p: Proposal) => void; onCreate: () => void; onCancel: () => void; busy: boolean;
}) {
  const edit = (pi: number, f: (p: Proposal["professions"][number]) => void) => {
    const next: Proposal = structuredClone(proposal);
    f(next.professions[pi]);
    onChange(next);
  };
  return (
    <Section title="Your proposed team" description="Change names, drop a coworker or a job, then create it. Jobs start off; each one asks for your OK.">
      {proposal.professions.map((p, pi) => (
        <Card key={p.id} className="cw-proposal">
          <h3 className="cw-h">{p.label}</h3>
          <ul className="cw-team">
            {p.team.map((m, mi) => (
              <li key={m.key} className="cw-member">
                <Input label={m.role === "coordinator" ? "Coordinator" : "Coworker"} value={m.name} maxLength={80}
                  onChange={(e) => edit(pi, (x) => { x.team[mi].name = e.target.value; })} />
                <span className="cw-role">{m.title}</span>
                {m.role !== "coordinator" && (
                  <label className="cw-check"><input type="checkbox" checked={m.include !== false}
                    onChange={(e) => edit(pi, (x) => { x.team[mi].include = e.target.checked; })} /> Include</label>
                )}
              </li>
            ))}
          </ul>
          <h4 className="cw-h4">Jobs</h4>
          {p.schedules.map((s, si) => (
            <div key={s.key} className="cw-job-pick">
              <label className="cw-check"><input type="checkbox" checked={s.include !== false}
                onChange={(e) => edit(pi, (x) => { x.schedules[si].include = e.target.checked; })} />
                <span><strong>{s.name}</strong> <span className="cw-role">{s.plain_time}</span></span></label>
              <p className="cw-meta">Reads: {s.card.reads} Changes: {s.card.changes} {s.card.risks}</p>
              {s.missing.length > 0 && <p className="cw-meta cw-warn">{s.missing.join(" ")} You can create the team now and connect it next.</p>}
            </div>
          ))}
          <Advanced label="Monthly limit per coworker">
            {p.team.map((m, mi) => (
              <Input key={m.key} type="number" min={0} label={`${m.name} (cents a month, 0 for no limit)`} value={String(m.monthly_budget_cents)}
                onChange={(e) => edit(pi, (x) => { x.team[mi].monthly_budget_cents = Math.max(0, Number(e.target.value) || 0); })} />
            ))}
          </Advanced>
        </Card>
      ))}
      <h4 className="cw-h4">Apps for this work</h4>
      <ul className="cw-apps">
        {proposal.integrations.map((i) => (
          <li key={i.key} className="cw-app">
            <span className="cw-between"><strong>{i.name}</strong>
              <Badge tone={i.connected ? "ok" : i.state === "ready" ? "neutral" : "warn"}>{i.connected ? "Connected" : i.state_label}</Badge></span>
            <span className="cw-line">{i.what}</span>
            <span className="cw-meta">{i.kind_label}. {i.tested}</span>
            {i.page && !i.connected && i.state !== "not_built" && <Link to={i.page} className="cw-link">Set it up</Link>}
          </li>
        ))}
      </ul>
      <p className="cw-meta"><ShieldCheck size={13} aria-hidden="true" /> {proposal.costs}</p>
      <div className="cw-actions">
        <Button variant="ghost" onClick={onCancel}>Back</Button>
        <Button variant="primary" icon={<Check size={14} />} busy={busy} onClick={onCreate}>Create the team</Button>
      </div>
    </Section>
  );
}
