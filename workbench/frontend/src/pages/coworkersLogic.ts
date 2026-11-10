// Pure helpers for the Coworkers page (feat/coworkers). Kept free of React so tests/coworkers.test.mjs can run them.

export type Card = { requester: string; action: string; when?: string; reads: string; changes: string; result: string; risks: string; choices: string[] };
export type Member = { key: string; name: string; title: string; instructions: string; role: "coordinator" | "coworker";
  monthly_budget_cents: number; include?: boolean };
export type ProposedJob = { key: string; name: string; cron: string; plain_time: string; agent: string; needs: string[];
  missing: string[]; card: Card; include?: boolean };
export type Integration = { key: string; name: string; kind: string; kind_label: string; state: string; state_label: string;
  what: string; tested: string; page: string; connected: boolean };
export type Proposal = { region: string; costs: string; integrations: Integration[];
  professions: { id: string; label: string; pack: string; team: Member[]; schedules: ProposedJob[] }[] };
export type SetupJob = { schedule_id: number; key: string; name: string; cron: string; state: "waiting" | "on" | "off";
  approved_at: string | null; last_run: string | null; last_status: string; next_run: string | null; card: Card; missing: string[] };
export type SetupView = { profession: string; label: string; region: string; created_at: string;
  team: { id: number; name: string; title: string; status: string; paused_reason: string; monthly_budget_cents: number }[];
  schedules: SetupJob[] };

export type ApplyBody = { profession: string; region: string;
  team: { key: string; name: string; title: string; instructions: string; monthly_budget_cents: number; include: boolean }[];
  schedules: { key: string; include: boolean }[] };

/** One /starters/apply body per profession. The coordinator is always kept; a job whose coworker was dropped goes to
 * the coordinator (the server does the same). Blank names fall back to the suggested name. */
export function proposalChoices(p: Proposal): ApplyBody[] {
  return p.professions.map((pr) => ({
    profession: pr.id,
    region: p.region,
    team: pr.team.map((m) => ({
      key: m.key, name: m.name.trim(), title: m.title, instructions: "",
      monthly_budget_cents: Math.max(0, Math.round(Number(m.monthly_budget_cents) || 0)),
      include: m.role === "coordinator" ? true : m.include !== false,
    })),
    schedules: pr.schedules.map((s) => ({ key: s.key, include: s.include !== false })),
  }));
}
