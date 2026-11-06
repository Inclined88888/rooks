/**
 * Module `routines` — recurring tasks driven by a cron expression.
 * Tier `std`. Injects `kanban`: a routine creates tasks.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Request, Response, Router } from 'express';
import { dbApi, isTaskType, type RoutineRow, type TaskType } from '../../db.js';
import { delegationRefusal } from '../../delegation-guard.js';
import { automationOriginOf, emitAutomationEvent } from '../../plugins/automation-events.js';
import { backupStatus, createRoutine, enableBackupRoutine, updateRoutine } from '../../routines.js';
import { forbidden, requestHasPermission } from '../../users/identity.js';
import { apiError } from '../../api-error.js';

/**
 * A routine is a schedule trigger (same rows, same Triggers page): the routes
 * ask what `/api/triggers` asks — an identity, `triggers:manage`, and the
 * caller only reaches its own rows (superadmin: all). Ownerless rows (the
 * daemon's, the nightly backup) are the superadmin's (TODO #573).
 */
const ROUTINES_PERMISSION = 'triggers:manage';
/** A routine opens tasks: what a trigger's `task` action needs. */
const TASK_PERMISSION = 'kanban:write';

function manager(req: Request, res: Response): boolean {
  if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return false; }
  if (!requestHasPermission(req, ROUTINES_PERMISSION)) {
    forbidden(req, res, { kind: 'permission', permission: ROUTINES_PERMISSION });
    return false;
  }
  return true;
}

function visible(req: Request, row: RoutineRow): boolean {
  if (req.auth?.isSuperadmin) return true;
  const me = req.auth?.user?.id ?? null;
  return me !== null && row.owner_user_id === me;
}

/** Someone else's routine answers like a missing one: its id leaks nothing. */
function loadVisible(req: Request, res: Response): RoutineRow | null {
  const value: unknown = req.params.id;
  const row = typeof value === 'string' ? dbApi.getRoutine(value) : undefined;
  if (!row || !visible(req, row)) { res.status(404).json(apiError('not_found', 'not found')); return null; }
  return row;
}

/**
 * Can this caller make `agent` receive a task at every tick? Its rows carry no
 * grants nor acting agent, so the run does not re-check: the save does, as a
 * trigger's save does — delegation first, then the task permission.
 */
function taskRefusal(req: Request, agent: string): string | null {
  const denied = delegationRefusal(req, agent);
  if (denied) return `task refused: ${denied}`;
  if (!requestHasPermission(req, TASK_PERMISSION)) return `not permitted: a routine opens tasks, which needs ${TASK_PERMISSION}`;
  return null;
}

/**
 * A routine opens a task at every tick, long after the mission that made it
 * and its revoked token: like a trigger (TODO #529), what an agent sets up is
 * born off and runs once a person switched it on. An agent cannot switch one
 * on, and changing what an enabled one does switches it off.
 */
const AGENT_ROUTINE_OFF = 'Saved switched off: a routine an agent sets up only runs once the user switches it on '
  + '(Triggers page). Tell the user it is waiting for them; do not create it again.';
const ROUTINE_BEHAVIOUR = ['agent_name', 'prompt', 'task_type', 'cron_expr', 'project'] as const;

/** Mission tokens are agents. Read from the credential, never from a header. */
function callerIsAgent(req: Request): boolean {
  return req.auth?.kind === 'api-token';
}

/**
 * The nightly backup archives the whole home, every account's data included,
 * and its status names where those archives lie: the superadmin's, like
 * `POST /api/admin/export` and `ctx.backup.enable` (TODO #611). A mission
 * reaches it only when its owner is a developer account; an ordinary one is
 * capped and gets a 403 pointing to the CLI.
 */
function backupOperator(req: Request, res: Response): boolean {
  if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return false; }
  if (!req.auth.isSuperadmin) {
    forbidden(req, res, {
      kind: 'operator',
      hint: 'The nightly backup covers every account: a superadmin manages it, or the operator runs `timon backup status|enable` from a terminal.',
    });
    return false;
  }
  return true;
}

export function registerRoutes(app: Router): void {
  app.get('/api/backup/status', (req, res) => {
    if (!backupOperator(req, res)) return;
    res.json(backupStatus());
  });

  app.post('/api/backup/enable', (req, res) => {
    if (!backupOperator(req, res)) return;
    try {
      res.json({ ok: true, ...enableBackupRoutine() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/routines', (req, res) => {
    if (!manager(req, res)) return;
    res.json({ routines: dbApi.listRoutines().filter((r) => visible(req, r)) });
  });

  app.get('/api/routines/:id', (req, res) => {
    if (!manager(req, res)) return;
    const r = loadVisible(req, res);
    if (r) res.json({ routine: r });
  });

  app.post('/api/routines', (req, res) => {
    if (!manager(req, res)) return;
    const body = req.body as {
      name?: string; agent_name?: string; prompt?: string;
      task_type?: string; cron_expr?: string; enabled?: boolean;
      project?: string | null;
    };
    if (!body.name || !body.agent_name || !body.prompt || !body.cron_expr) {
      res.status(400).json({ error: 'name, agent_name, prompt, cron_expr required' });
      return;
    }
    if (body.task_type !== undefined && !isTaskType(body.task_type)) {
      res.status(400).json({ error: `invalid task_type "${body.task_type}"` });
      return;
    }
    const refused = taskRefusal(req, body.agent_name);
    if (refused) { res.status(403).json({ error: refused }); return; }
    const byAgent = callerIsAgent(req);
    try {
      const r = createRoutine({
        name: body.name,
        agent_name: body.agent_name,
        prompt: body.prompt,
        task_type: body.task_type as TaskType | undefined,
        cron_expr: body.cron_expr,
        enabled: byAgent ? false : body.enabled,
        project: body.project ?? null,
        ownerUserId: req.auth?.user?.id ?? null,
      });
      emitAutomationEvent({ kind: 'routine_created', row: r, origin: automationOriginOf(req) });
      res.status(201).json({ routine: r, ...(byAgent ? { needs_activation: true, message: AGENT_ROUTINE_OFF } : {}) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/routines/:id', (req, res) => {
    if (!manager(req, res)) return;
    const r = loadVisible(req, res);
    if (!r) return;
    const body = req.body as Record<string, unknown>;
    if (body.task_type !== undefined && !isTaskType(body.task_type)) {
      res.status(400).json({ error: `invalid task_type "${body.task_type}"` });
      return;
    }
    const fields = {
      name: typeof body.name === 'string' ? body.name : undefined,
      agent_name: typeof body.agent_name === 'string' ? body.agent_name : undefined,
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      task_type: body.task_type as TaskType | undefined,
      cron_expr: typeof body.cron_expr === 'string' ? body.cron_expr : undefined,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      project: 'project' in body ? (body.project as string | null) : undefined,
    };
    // Switching off (or renaming) asks nothing more; anything that leaves it
    // opening tasks needs the caller to be allowed to open them, as on create.
    const offOnly = Object.entries(fields).every(([key, value]) => value === undefined || key === 'name'
      || (key === 'enabled' && value === false));
    if (!offOnly) {
      const refused = taskRefusal(req, fields.agent_name ?? r.agent_name);
      if (refused) { res.status(403).json({ error: refused }); return; }
    }
    let switchedOff = false;
    if (callerIsAgent(req)) {
      if (r.enabled !== 1 && fields.enabled === true) {
        res.status(403).json({ error: 'an agent cannot switch a routine on: the user does it (Triggers page)' });
        return;
      }
      switchedOff = r.enabled === 1 && fields.enabled !== false
        && ROUTINE_BEHAVIOUR.some((key) => fields[key] !== undefined && fields[key] !== r[key]);
      if (switchedOff) fields.enabled = false;
    }
    try {
      const updated = updateRoutine(r.id, fields);
      emitAutomationEvent({ kind: 'routine_updated', row: updated, origin: automationOriginOf(req) });
      res.json({ routine: updated, ...(switchedOff ? { needs_activation: true, message: AGENT_ROUTINE_OFF } : {}) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/routines/:id', (req, res) => {
    if (!manager(req, res)) return;
    const r = loadVisible(req, res);
    if (!r) return;
    dbApi.deleteRoutine(r.id);
    emitAutomationEvent({ kind: 'routine_deleted', row: r, origin: automationOriginOf(req) });
    res.json({ ok: true });
  });
}
