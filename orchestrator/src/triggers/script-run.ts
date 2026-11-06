/**
 * The `script` action (TODO #421): a trigger runs a program on the host, with
 * no agent and no model — a tick costs no token. Meant for a deterministic job
 * on a short cadence (a watcher every five minutes) that wakes an agent only
 * when there is something to do, for instance by running `timon task create`
 * itself.
 *
 * `runActions` is synchronous, so the action only starts the process and
 * answers with a run id; the outcome (exit code, duration, end of output) is a
 * second journal entry, keyed `script:<run id>`, written when the process ends.
 *
 * What protects the host:
 *  - the action needs `scripts:run`, which no mission token holds, and an
 *    agent is refused outright (`plugins-bundled/triggers/routes.ts`);
 *  - argv, no shell, nothing from a payload;
 *  - `cwd` inside a registered project, symlinks resolved, at every run;
 *  - an environment built from the system whitelist plus the vault secrets it
 *    names — never the daemon's own environment (`secrets/env.ts`);
 *  - a time limit that kills the whole process tree, a bounded output tail,
 *    no overlap by default, a global ceiling on concurrent runs, and the
 *    trigger switched off after consecutive failures.
 */
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { db, dbApi } from '../db.js';
import { getHost } from '../host/index.js';
import { stopProcessGroup } from '../host/kill-tree.js';
import { createNotification } from '../notifications.js';
import { TIMON_HOME } from '../paths.js';
import { secretsEnvFor, systemEnv } from '../secrets/env.js';
import { redactDeep } from '../secrets/redact.js';
import { projectFromRegisteredCwd } from '../task-project.js';
import { SCRIPT_DEFAULT_TIMEOUT_S, type TriggerAction } from './schema.js';
import { disableTriggerRow, recordDelivery, type Trigger } from './store.js';

export type ScriptAction = Extract<TriggerAction, { type: 'script' }>;

/** Characters of each stream kept for the journal and the alert. */
export const SCRIPT_TAIL_CHARS = 2000;
/** Characters of each stream held in memory while it runs; the rest is dropped. */
const BUFFER_CHARS = 64 * 1024;
/** Runs of every trigger at once: beyond, a tick is skipped. */
export const MAX_CONCURRENT_SCRIPTS = 8;
/** Consecutive failed runs after which the trigger is switched off. */
export const SCRIPT_DISABLE_AFTER = 5;
/** Between the polite stop and the forced one, once the time limit is hit. */
const KILL_GRACE_MS = 5_000;

type Running = { child: ChildProcess; triggerId: string };
const running = new Map<string, Running>();
/** `trigger id#action index` of the runs in progress, for `overlap: skip`. */
const busy = new Set<string>();

/**
 * Real path of `cwd` and the project that contains it, or why not. Both sides
 * resolved: a symlink inside a project must not lead out of it, and a project
 * registered through a symlink still matches.
 */
export function scriptCwd(cwd: string): { cwd: string; project: string } | { error: string } {
  if (!isAbsolute(cwd)) return { error: 'cwd: an absolute path' };
  let real: string;
  try { real = realpathSync(cwd); } catch { return { error: `cwd not found: ${cwd}` }; }
  const roots = dbApi.listProjectRows().flatMap((row) => {
    if (!row.cwd) return [];
    try { return [{ slug: row.slug, cwd: realpathSync(row.cwd) }]; } catch { return []; }
  });
  const project = projectFromRegisteredCwd(real, roots);
  return project ? { cwd: real, project } : { error: `cwd is not inside a registered project: ${cwd}` };
}

/** The executable as written, a path relative to `cwd` made absolute. */
function executable(command: string, cwd: string): string {
  if (isAbsolute(command)) return command;
  return command.includes('/') || command.includes(sep) ? resolve(cwd, command) : command;
}

/** Literal replacement of every injected value, then the known token shapes. */
export function scrubOutput(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length > 0) out = out.split(value).join(`[secret ${name}]`);
  }
  return redactDeep(out);
}

function tail(text: string, max: number = SCRIPT_TAIL_CHARS): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

/** What the dry run shows: the command, never a secret value. */
export function scriptPreview(action: ScriptAction): Record<string, unknown> {
  return {
    type: 'script', command: action.command, args: action.args ?? [], cwd: action.cwd, env: action.env ?? [],
    timeout_s: action.timeout_s ?? SCRIPT_DEFAULT_TIMEOUT_S, overlap: action.overlap ?? 'skip',
    notify_on_failure: action.notify_on_failure ?? true,
  };
}

export type ScriptResult = {
  run_id: string;
  code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
};

/** True when the last `SCRIPT_DISABLE_AFTER` finished runs of the trigger all failed. */
function failingStreak(triggerId: string): boolean {
  const rows = db.prepare(
    `SELECT status FROM trigger_deliveries WHERE trigger_id = ? AND delivery_key LIKE 'script:%' ORDER BY id DESC LIMIT ?`,
  ).all(triggerId, SCRIPT_DISABLE_AFTER) as { status: string }[];
  return rows.length >= SCRIPT_DISABLE_AFTER && rows.every((row) => row.status === 'error');
}

function alert(trigger: Trigger, title: string, body: string): void {
  try {
    // `trigger:<id>` as source: an event trigger never fires on its own alerts.
    createNotification({ type: 'alert', title, body, ownerUserId: trigger.ownerUserId, source: `trigger:${trigger.id}` });
  } catch (err) {
    console.warn(`[triggers] script alert for ${trigger.id} not sent: ${(err as Error).message}`);
  }
}

function finish(trigger: Trigger, action: ScriptAction, result: ScriptResult, error: string | null): void {
  recordDelivery({
    triggerId: trigger.id, status: error ? 'error' : 'received', deliveryKey: `script:${result.run_id}`,
    reason: error ? `script: ${error}` : `script: exit code 0 in ${result.duration_ms} ms`,
    result: { type: 'script', ...result },
  });
  if (!error) return;
  if (action.notify_on_failure !== false) {
    const output = [result.stderr_tail, result.stdout_tail].filter(Boolean).join('\n\n');
    alert(trigger, `Script failed: ${trigger.name}`, `${error}${output ? `\n\n${tail(output, SCRIPT_TAIL_CHARS)}` : ''}`);
  }
  if (failingStreak(trigger.id) && disableTriggerRow(trigger.id)) {
    alert(trigger, `Trigger switched off: ${trigger.name}`,
      `Its script failed ${SCRIPT_DISABLE_AFTER} times in a row. Fix it, then switch the trigger back on.`);
  }
}

/**
 * Starts one run and returns its id, or `null` when it is skipped (previous run
 * still going, or the concurrency ceiling reached). Never throws for a run that
 * cannot start: that failure is journaled like any other, so it counts toward
 * the switch-off and raises the same alert.
 */
export function startScript(trigger: Trigger, action: ScriptAction, index: number): string | null {
  const key = `${trigger.id}#${index}`;
  if ((action.overlap ?? 'skip') === 'skip' && busy.has(key)) return null;
  if (running.size >= MAX_CONCURRENT_SCRIPTS) return null;
  const runId = randomUUID();
  const startedAt = Date.now();
  const empty = (error: string): void => {
    setImmediate(() => finish(trigger, action, {
      run_id: runId, code: null, signal: null, timed_out: false, duration_ms: 0, stdout_tail: '', stderr_tail: '',
    }, error));
  };
  const place = scriptCwd(action.cwd);
  if ('error' in place) { empty(place.error); return runId; }
  const granted = secretsEnvFor({ project: place.project });
  const missing = (action.env ?? []).filter((name) => !Object.hasOwn(granted, name));
  if (missing.length) { empty(`secret not granted to project ${place.project}: ${missing.join(', ')}`); return runId; }
  const secrets = Object.fromEntries((action.env ?? []).map((name) => [name, granted[name]!]));
  const env: NodeJS.ProcessEnv = { ...systemEnv(), TIMON_HOME, ...secrets };

  let child: ChildProcess;
  try {
    child = getHost().spawn(executable(action.command, place.cwd), action.args ?? [], {
      cwd: place.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      // Its own process group off Windows, so the time limit reaches what it started.
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    empty(`could not start: ${(err as Error).message}`);
    return runId;
  }
  busy.add(key);
  running.set(runId, { child, triggerId: trigger.id });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-BUFFER_CHARS); });
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-BUFFER_CHARS); });

  let timedOut = false;
  let forced: NodeJS.Timeout | null = null;
  const timeoutMs = (action.timeout_s ?? SCRIPT_DEFAULT_TIMEOUT_S) * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    stopProcessGroup(child, 'SIGTERM');
    forced = setTimeout(() => {
      stopProcessGroup(child, 'SIGKILL');
      // A detached grandchild may hold the pipes open, and `close` never comes:
      // the run ends here anyway, or every later tick would be skipped.
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(null, 'SIGKILL', null);
    }, KILL_GRACE_MS);
    forced.unref();
  }, timeoutMs);
  timer.unref();

  let settled = false;
  const settle = (code: number | null, signal: string | null, startError: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forced) clearTimeout(forced);
    busy.delete(key);
    running.delete(runId);
    const result: ScriptResult = {
      run_id: runId, code, signal, timed_out: timedOut, duration_ms: Date.now() - startedAt,
      // Scrubbed on the whole buffer, then cut: a value is never split by the cut.
      stdout_tail: tail(scrubOutput(stdout, secrets)),
      stderr_tail: tail(scrubOutput(stderr, secrets)),
    };
    const error = startError
      ?? (timedOut ? `timed out after ${action.timeout_s ?? SCRIPT_DEFAULT_TIMEOUT_S} s`
        : code !== 0 ? (signal ? `killed by ${signal}` : `exit code ${code}`) : null);
    try {
      finish(trigger, action, result, error);
    } catch (err) {
      console.error(`[triggers] script journal of ${trigger.id} failed:`, (err as Error).message);
    }
  };
  child.on('error', (err) => settle(null, null, `could not start: ${scrubOutput(err.message, secrets)}`));
  child.on('close', (code, signal) => settle(code, signal, null));
  return runId;
}

/** Plugin dispose: what still runs is stopped, and journaled by its own `close`. */
export function stopScripts(): void {
  for (const { child } of running.values()) stopProcessGroup(child, 'SIGTERM');
}

/** Tests: runs in progress. */
export function runningScripts(): number {
  return running.size;
}
