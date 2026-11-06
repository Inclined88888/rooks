/**
 * Input validation guards of the tasks/roles routes.
 *
 * PURE module: no runtime import (no database, no disk) to stay
 * testable without side effects — see `task-guards.test.ts`.
 *
 * Same discipline as the validation of `pipeline` / `backend_override` /
 * `project` in index.ts: an unknown value is NEVER guessed nor
 * silently neutralised, it is rejected with a 400 and an explicit message.
 * Motivation: incident of 2026-08-06, a project role pointing at an agent of
 * another repo — the tasks created worktrees in the wrong repository without the
 * slightest signal.
 *
 * NB: the sleepless night of 2026-08-05 to 06 had a DIFFERENT cause, and
 * `validateScheduledAt` would not have caught it. The 5 tasks created at 22:45 on the
 * 5th targeted the night of the 6th to the 7th instead of the 5th to the 6th: a perfectly valid numeric
 * timestamp, but shifted by 24 h. The dispatcher was right not to
 * take them. That is what `checkScheduledAtPlausibility` below covers —
 * validating the SHAPE says nothing of the SEMANTIC correctness.
 */

/** Epoch ms at 2001-09-09. A lower timestamp is almost always an
 *  epoch in SECONDS passed as is: it would land in the past, hence
 *  dispatched immediately instead of being deferred — exactly the symptom
 *  we want to make impossible. */
const MIN_EPOCH_MS = 1_000_000_000_000;

export type ScheduledAtCheck =
  | { ok: true; value: number | null | undefined }
  | { ok: false; error: string };

/**
 * Validates `body.scheduled_at`.
 *
 * - absent (`undefined`) → no change (`value: undefined`)
 * - `null` → "no scheduling". On CREATION, the task leaves immediately.
 *   On UPDATE, `null` is a NO-OP (see `clear_scheduled_at` on the API side):
 *   it is the historical COALESCE semantics, kept so as not to erase by
 *   surprise the scheduling of the clients that send back their whole form.
 * - finite number ≥ MIN_EPOCH_MS → accepted
 * - everything else (ISO string, NaN, Infinity, bool, object, epoch seconds) →
 *   explicit rejection.
 */
export function validateScheduledAt(raw: unknown): ScheduledAtCheck {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return {
      ok: false,
      error: `invalid scheduled_at (${JSON.stringify(raw)}): expected a Unix timestamp `
        + `in milliseconds (number), not an ISO string nor a text date. `
        + `E.g. new Date("2026-01-01T02:00:00").getTime()`,
    };
  }
  if (raw < MIN_EPOCH_MS) {
    return {
      ok: false,
      error: `invalid scheduled_at (${raw}): expected a timestamp in milliseconds, `
        + `this value looks like seconds (it points to `
        + `${new Date(raw).toISOString()}, hence an immediate dispatch)`,
    };
  }
  return { ok: true, value: raw };
}

/** Beyond this horizon, a scheduling announced as "tonight" is
 *  almost surely shifted by a day. 18 h covers the latest legitimate case
 *  (creating at 06:00 for 00:00 the following night = exactly 18 h) without letting
 *  the 24 h shift through. */
const PLAUSIBILITY_HORIZON_MS = 18 * 60 * 60 * 1000;

/**
 * Flags a suspicious scheduling WITHOUT refusing it.
 *
 * A warning and not a rejection, because a task legitimately planned for
 * next week is indistinguishable from an accidental shift: only the human
 * knows the intent. The doubt is made visible instead of settled.
 *
 * Founding incident (night of 2026-08-05 to 06): 5 tasks created at 22:45 for
 * the night of the 6th to the 7th while "tonight" meant that of the 5th to the 6th. Nothing
 * crashed, nothing alerted — they simply slept 24 h too long.
 */
export function checkScheduledAtPlausibility(
  value: number | null | undefined,
  now: number,
): string | null {
  if (typeof value !== 'number') return null;
  const delta = value - now;
  if (delta <= PLAUSIBILITY_HORIZON_MS) return null;
  const hours = Math.round(delta / 3_600_000);
  return `scheduled_at is ${hours} h in the future (${new Date(value).toISOString()}). `
    + `If the intent was "tonight", this is probably a 24 h shift: `
    + `"tonight" = the NEXT occurrence of the 00:00–07:00 window from `
    + `now, not the night after. Task created anyway.`;
}

/** Normalises a path for comparison: trailing slash removed, empty string
 *  brought back to null. No realpath (this module stays pure / without I/O). */
export function normalizeCwd(cwd: string | null | undefined): string | null {
  if (typeof cwd !== 'string') return null;
  const trimmed = cwd.trim().replace(/\/+$/, '');
  return trimmed || null;
}

export type RoleCwdInput = {
  slug: string;
  role: string;
  agent: string;
  /** The agent's cwd, or null if it has none / does not exist yet. */
  agentCwd: string | null;
  /** Registered cwd of the project, or null if it has none. */
  projectCwd: string | null;
  /** Does the agent already exist on disk? An agent to create cannot be checked. */
  agentExists: boolean;
  force?: boolean;
};

/**
 * Checks that an agent assigned to a project role really works IN the project.
 *
 * Returns an error message (→ 400) if the agent exists, has a cwd, the
 * project has a cwd, and the two differ. `force: true` overrides it — the
 * legitimate case of a generic agent shared on purpose.
 *
 * Founding incident (2026-08-06): a project had `TIMON.coder`
 * (cwd = another repository) in the `code` role. The tasks created worktrees in the
 * WRONG repo and ran all night without a single alert.
 */
export function checkRoleAgentCwd(input: RoleCwdInput): string | null {
  if (input.force) return null;
  if (!input.agentExists) return null;
  const agentCwd = normalizeCwd(input.agentCwd);
  const projectCwd = normalizeCwd(input.projectCwd);
  if (!agentCwd || !projectCwd) return null;
  if (agentCwd === projectCwd) return null;
  return `agent "${input.agent}" has cwd ${agentCwd}, different from the cwd of project `
    + `"${input.slug}" (${projectCwd}) — a project must never reuse an agent `
    + `of another project (its ${input.role} tasks would create worktrees in the wrong `
    + `repo). Create a dedicated agent, or send force:true if sharing is intended.`;
}
