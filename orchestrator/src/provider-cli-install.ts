/**
 * An AI CLI's official installer, run as a JOB whose console the screen follows
 * (TODO #251, SUG-0005).
 *
 * The request used to hold until the installer ended, up to fifteen minutes on
 * a slow link, behind a button that said nothing. The install now starts in the
 * background and answers at once with the command it runs; the screen then polls
 * the job and shows the installer's own lines as they come. What to run is still
 * decided here, from the closed list of `onboarding.ts`: the client names a CLI,
 * never a command.
 *
 * One job per CLI at a time: a second click, or a second screen, joins the one
 * under way. A finished job stays readable until the next install of that CLI,
 * so a page reloaded at the end still shows how it went.
 */
import type { ChildProcess } from 'node:child_process';
import { config } from './config/load.js';
import { whichBin } from './doctor.js';
import { getHost } from './host/index.js';
import { installBackendPlanFor, type InstallableBackend } from './host/machine.js';
import { killProcessTree } from './host/kill-tree.js';
import type { ExecResult } from './host/types.js';
import { runInstallBackend, type OnboardingResult } from './onboarding.js';

/** A large native binary on a slow link: well past the npm installs' five minutes. */
export const INSTALL_TIMEOUT_MS = 900_000;
/** Lines kept per job: enough to read an error, bounded whatever the installer prints. */
const MAX_LINES = 300;
const MAX_LINE_LENGTH = 500;
/** What `failureReason` reads per stream: the end of the output is where installers say why. */
const MAX_CAPTURE = 64_000;

export type InstallJobState = 'running' | 'succeeded' | 'failed';

export type InstallJob = {
  name: string;
  /** The line being run, as the person would paste it. */
  command: string;
  state: InstallJobState;
  startedAt: number;
  finishedAt: number | null;
  /** The installer's console, oldest first, without colours or progress-bar redraws. */
  lines: string[];
  /** Lines dropped from the head once `MAX_LINES` was reached. */
  dropped: number;
  /** The verdict once the job has ended; `null` while it runs. */
  result: OnboardingResult | null;
};

// CSI sequences (colours, cursor moves) and OSC sequences (window titles, links).
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/**
 * Turns the raw output of an installer into lines a person can read. curl and
 * PowerShell draw their progress bars by rewriting one line with `\r`: only
 * what stands last on that line is kept, or a download would print a thousand.
 */
export class ConsoleLog {
  readonly lines: string[] = [];
  dropped = 0;
  private partial = '';

  push(chunk: string): void {
    const parts = (this.partial + chunk).split('\n');
    this.partial = parts.pop() ?? '';
    for (const part of parts) this.add(part);
  }

  /** The line still open when the process ended. */
  flush(): void {
    if (this.partial) this.add(this.partial);
    this.partial = '';
  }

  private add(raw: string): void {
    const redraws = raw.replace(/\r$/, '').split('\r');
    const last = [...redraws].reverse().find((segment) => segment.trim() !== '') ?? '';
    const line = last.replace(ANSI, '').replace(/\s+$/, '');
    if (!line.trim()) return;
    this.lines.push(line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line);
    if (this.lines.length > MAX_LINES) {
      this.lines.shift();
      this.dropped += 1;
    }
  }
}

type Spawn = (command: string, args: string[]) => ChildProcess;

/**
 * `execAsync`, but each line reaches `log` as the installer prints it. Never
 * throws: a binary that cannot start (no `powershell`, no `/bin/sh`) is an
 * answer with its reason, like the host adapter's own refusals.
 */
export function streamingExec(
  command: string,
  args: string[],
  log: ConsoleLog,
  opts: { timeoutMs?: number; spawn?: Spawn; kill?: (child: ChildProcess) => void } = {},
): Promise<ExecResult> {
  const spawn = opts.spawn ?? ((cmd, argv) => getHost().spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  const kill = opts.kill ?? ((child) => killProcessTree(child));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const keep = (held: string, chunk: string): string => (held + chunk).slice(-MAX_CAPTURE);
    let child: ChildProcess;
    try {
      child = spawn(command, args);
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: (error as Error).message });
      return;
    }
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.flush();
      resolve(result);
    };
    const timer = setTimeout(() => {
      const minutes = Math.round((opts.timeoutMs ?? INSTALL_TIMEOUT_MS) / 60_000);
      log.push(`\nThe installer was stopped after ${minutes} min.\n`);
      kill(child);
      finish({ code: 124, stdout, stderr: keep(stderr, `the installer did not finish within ${minutes} min`) });
    }, opts.timeoutMs ?? INSTALL_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout = keep(stdout, chunk); log.push(chunk); });
    child.stderr?.on('data', (chunk: string) => { stderr = keep(stderr, chunk); log.push(chunk); });
    child.on('error', (error) => finish({ code: 127, stdout, stderr: keep(stderr, error.message) }));
    child.on('close', (code, signal) => finish({ code: code ?? (signal ? 1 : 0), stdout, stderr }));
  });
}

type Entry = { job: InstallJob; log: ConsoleLog; done: Promise<OnboardingResult> };
const jobs = new Map<string, Entry>();

export type InstallDeps = {
  platform?: NodeJS.Platform;
  exec?: (command: string, args: string[], log: ConsoleLog) => Promise<ExecResult>;
  locate?: (name: string) => string | null;
  /** Run once an install has succeeded: the daemon looks for its CLIs again. */
  afterSuccess?: (name: string) => Promise<void> | void;
};

function snapshot(entry: Entry): InstallJob {
  return { ...entry.job, lines: [...entry.log.lines], dropped: entry.log.dropped };
}

/**
 * Starts the official installer of `name`, or joins the one already running.
 * `name` must come from the closed list; on an OS its vendor gives no installer
 * for, the caller refuses before getting here (`installBackendPlanFor` → null).
 */
export function startCliInstall(name: InstallableBackend, deps: InstallDeps = {}): InstallJob {
  const running = jobs.get(name);
  if (running && running.job.state === 'running') return snapshot(running);
  const platform = deps.platform ?? process.platform;
  const plan = installBackendPlanFor(name, platform);
  if (!plan) throw new Error(`${name} has no official installer on ${platform}`);
  const log = new ConsoleLog();
  const job: InstallJob = {
    name, command: plan.display, state: 'running', startedAt: Date.now(), finishedAt: null, lines: [], dropped: 0, result: null,
  };
  const exec = deps.exec ?? ((command, args, into) => streamingExec(command, args, into));
  const locate = deps.locate ?? ((binary: string) => whichBin(binary, config().host.binaries).path);
  const done = runInstallBackend(name, platform, (command, args) => exec(command, args, log), locate)
    .catch((error: unknown): OnboardingResult => ({ ok: false, lines: [], command: plan.display, reason: (error as Error).message }))
    .then(async (result) => {
      if (result.ok && deps.afterSuccess) {
        try { await deps.afterSuccess(name); } catch (error) { console.warn(`[provider-cli] after installing ${name}: ${(error as Error).message}`); }
      }
      job.result = result;
      job.state = result.ok ? 'succeeded' : 'failed';
      job.finishedAt = Date.now();
      return result;
    });
  jobs.set(name, { job, log, done });
  return snapshot({ job, log, done });
}

/** The job of `name` — running, or the last one that ended — or `null`. */
export function cliInstallJob(name: string): InstallJob | null {
  const entry = jobs.get(name);
  return entry ? snapshot(entry) : null;
}

/** Resolves when the current job of `name` ends; `null` when none was started. */
export function cliInstallDone(name: string): Promise<OnboardingResult> | null {
  return jobs.get(name)?.done ?? null;
}

export function resetCliInstallsForTests(): void {
  jobs.clear();
}
