/**
 * The steps before "Make this machine reachable": install Tailscale, sign
 * this machine in, and on Linux let this account drive `tailscale serve`
 * without sudo. Each is a job the screen starts with one click and then
 * follows by polling `status()`: an installer waits on a password, a sign-in
 * on a browser tab, and no HTTP request may stay open for either.
 *
 * One job at a time, in memory: a restart forgets it, and the next `status()`
 * reads the machine itself (installed? signed in?) — the job only adds what
 * the machine cannot say (which phase, why it failed, the sign-in URL).
 *
 * Nothing here takes a value from the client: the URLs are constants
 * (`host/tailscale-install.ts`), the sign-in URL is read from tailscale's own
 * output and only ever on login.tailscale.com. The client may only say that it
 * is the desktop app (`client: 'desktop'`), and later how the installer it
 * opened ended — never which file, URL or command.
 *
 * The handoff: a packaged daemon has no desktop (Windows session 0, macOS
 * LaunchDaemon), so it verifies the package and stops at `handoff`, the
 * verified file's path and sha256 in the job. The desktop app reads them from
 * `status()`, checks the sha256 again, opens the installer in the user's
 * session and reports back; the directory is removed then, or after
 * `HANDOFF_TIMEOUT_MS` when no app ever came for it.
 */
import type { ChildProcess } from 'node:child_process';
import { config } from './config/load.js';
import { whichBin } from './doctor.js';
import { getHost } from './host/index.js';
import {
  allowTailscaleOperator,
  installTailscale,
  nodeInstallFs,
  tailscaleManualOperatorCommand,
  tailscaleManualInstallCommand,
  type TailscaleInstallFailure,
  type TailscaleInstallPhase,
  type TailscaleInstallResult,
} from './host/tailscale-install.js';
import { tailscaleCliOpts } from './host/tailscale-cli.js';
import type { ExecResult } from './host/types.js';
import { manualCommand } from './tailnet-publish.js';

/** What the machine says about its Tailscale node. */
export type TailscaleNodeState =
  | 'not_installed'
  /** Installed, no node answering: tailscaled stopped, or the macOS/Windows app not open. */
  | 'unreachable'
  /** The CLI exited 0 without JSON: what it printed is in `error`. */
  | 'unreadable'
  | 'needs_login'
  | 'stopped'
  | 'starting'
  | 'running';

export type SetupJobKind = 'install' | 'connect' | 'operator';
/** `handoff`: verified, waiting for the desktop app to open it in the user's session. */
export type SetupJobPhase = TailscaleInstallPhase | 'handoff' | 'waiting_login' | 'done' | 'failed';
export type SetupJobFailure =
  | TailscaleInstallFailure
  | 'not_installed'
  /** The node is not answering: the app must be opened (macOS, Windows) or tailscaled started. */
  | 'not_running'
  /** This account may not change Tailscale's settings (Linux without `--operator`). */
  | 'permission'
  | 'failed';

export type SetupJob = {
  kind: SetupJobKind;
  phase: SetupJobPhase;
  failure: SetupJobFailure | null;
  /** What to run by hand when the button could not. */
  command: string | null;
  detail: string | null;
  /** Sign-in page tailscale printed, only on login.tailscale.com. */
  authUrl: string | null;
  /** The verified package the desktop app opens, while `handoff`. */
  installer: { path: string; sha256: string } | null;
  startedAt: number;
};

/** How the installer the desktop app opened ended, as it reports it. */
export type InstallerReport = {
  /** Binds the report to the package it is about: a stale one closes nothing. */
  sha256: string;
  outcome: 'installed' | 'cancelled' | 'failed';
  /** The installer's exit code, for the detail line. */
  code?: number;
};

export type TailscaleSetupStatus = {
  platform: NodeJS.Platform;
  state: TailscaleNodeState;
  /** First line the CLI printed instead of its status, for `unreadable` only. */
  error: string | null;
  job: SetupJob | null;
};

/** The running `tailscale up`, reduced to what the job needs. */
export type UpProcess = {
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
};

export type TailscaleSetupDeps = {
  platform: NodeJS.Platform;
  /** Re-resolved on every call: the binary appears once the installer is done. */
  binary(): string | null;
  run(binary: string, args: string[], timeoutMs: number): Promise<ExecResult>;
  spawnUp(binary: string): UpProcess;
  install(onPhase: (phase: TailscaleInstallPhase) => void, delegate: boolean): Promise<TailscaleInstallResult>;
  /** Removes a handed-over package's directory. */
  removeDir(path: string): Promise<void>;
  allowOperator(binary: string): ReturnType<typeof allowTailscaleOperator>;
  /** macOS: open the app the CLI lives in, which owns the node. */
  launchApp(binary: string): Promise<void>;
  now(): number;
};

const STATUS_TIMEOUT_MS = 10_000;
/** How long `connect()` waits for tailscale to print a sign-in URL before answering. */
const AUTH_URL_WAIT_MS = 8_000;
/** A sign-in nobody completes ends here; `tailscale up` is killed with it. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const AUTH_URL = /https:\/\/login\.tailscale\.com\/[^\s"'<>]+/;
/** The desktop app waits up to 30 min on its installer; past this, nobody is coming for the package. */
export const HANDOFF_TIMEOUT_MS = 35 * 60_000;
const OUTPUT_MAX = 16 * 1024;

export function authUrlIn(text: string): string | null {
  return AUTH_URL.exec(text)?.[0] ?? null;
}

/** `tailscale status --json`, read for its state and a pending sign-in URL. */
export function nodeStateOf(payload: unknown): { state: TailscaleNodeState; authUrl: string | null } {
  const root = (payload ?? {}) as { BackendState?: unknown; AuthURL?: unknown };
  const authUrl = typeof root.AuthURL === 'string' ? authUrlIn(root.AuthURL) : null;
  switch (root.BackendState) {
    case 'Running': return { state: 'running', authUrl: null };
    case 'NeedsLogin':
    case 'NeedsMachineAuth': return { state: 'needs_login', authUrl };
    case 'Stopped': return { state: 'stopped', authUrl: null };
    case 'Starting': return { state: 'starting', authUrl };
    default: return { state: 'unreachable', authUrl: null };
  }
}

/** Why `tailscale up` stopped, read off what it printed. */
export function classifyUpOutput(output: string): 'permission' | 'not_running' | 'failed' {
  if (/access denied|permission denied|--operator|prefs write access|must be (run as )?root|requires root/i.test(output)) return 'permission';
  if (/is tailscale running|failed to connect to local tailscale|tailscaled|not running|no such file/i.test(output)) return 'not_running';
  return 'failed';
}

/** `/Applications/Tailscale.app/Contents/MacOS/Tailscale` → `/Applications/Tailscale.app`. */
export function appBundleOf(binary: string): string | null {
  const at = binary.indexOf('.app/');
  return at > 0 ? binary.slice(0, at + 4) : null;
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 200) : null;
}

const ACTIVE: ReadonlySet<SetupJobPhase> = new Set(['downloading', 'verifying', 'installing', 'handoff', 'waiting_login']);

export class TailscaleSetup {
  private job: SetupJob | null = null;
  private up: UpProcess | null = null;
  private upTimer: ReturnType<typeof setTimeout> | null = null;
  /** The handed-over package's directory, until the app reports or the timer fires. */
  private handoff: { dir: string; sha256: string; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly deps: TailscaleSetupDeps) {}

  private start(kind: SetupJobKind, phase: SetupJobPhase): SetupJob {
    this.job = { kind, phase, failure: null, command: null, detail: null, authUrl: null, installer: null, startedAt: this.deps.now() };
    return this.job;
  }

  private dropHandoff(): void {
    const handoff = this.handoff;
    this.handoff = null;
    if (!handoff) return;
    clearTimeout(handoff.timer);
    void this.deps.removeDir(handoff.dir).catch(() => undefined);
  }

  private busy(): boolean {
    return this.job !== null && ACTIVE.has(this.job.phase);
  }

  private fail(job: SetupJob, failure: SetupJobFailure, command: string | null, detail: string | null): void {
    job.phase = 'failed';
    job.failure = failure;
    job.command = command;
    job.detail = detail;
  }

  private stopUp(): void {
    if (this.upTimer) clearTimeout(this.upTimer);
    this.upTimer = null;
    const up = this.up;
    this.up = null;
    try { up?.kill(); } catch { /* already gone */ }
  }

  async status(): Promise<TailscaleSetupStatus> {
    const binary = this.deps.binary();
    let state: TailscaleNodeState = 'not_installed';
    let authUrl: string | null = null;
    let error: string | null = null;
    if (binary) {
      let r: ExecResult | null = null;
      try { r = await this.deps.run(binary, ['status', '--json'], STATUS_TIMEOUT_MS); } catch { r = null; }
      let payload: unknown = null;
      // `status` may exit non-zero when logged out yet still print the JSON: the payload decides.
      try {
        payload = r && r.stdout.trim() ? JSON.parse(r.stdout) as unknown : null;
      } catch {
        if (r?.code === 0) error = firstLine(`${r.stdout}\n${r.stderr}`);
      }
      ({ state, authUrl } = error ? { state: 'unreadable' as const, authUrl: null } : nodeStateOf(payload));
    }
    const job = this.job;
    // Installed while the app's installer still runs: the card moves on. The
    // package stays until the app reports, the installer may still read it.
    if (job?.kind === 'install' && job.phase === 'handoff' && state !== 'not_installed') {
      job.phase = 'done';
      job.installer = null;
    }
    if (job?.kind === 'connect' && job.phase === 'waiting_login') {
      if (state === 'running') {
        job.phase = 'done';
        this.stopUp();
      } else if (!job.authUrl && authUrl) {
        job.authUrl = authUrl;
      }
    }
    return { platform: this.deps.platform, state, error, job: job ? { ...job } : null };
  }

  /**
   * Starts the official installer; already installed or already busy = nothing new.
   * `client: 'desktop'`: the Timon desktop app asks, and can open the installer
   * itself when the daemon has no desktop.
   */
  async install(opts: { client?: 'desktop' } = {}): Promise<TailscaleSetupStatus> {
    if (this.busy() || this.deps.binary()) return this.status();
    this.dropHandoff();
    const job = this.start('install', 'downloading');
    void this.deps.install((phase) => { if (this.job === job && ACTIVE.has(job.phase)) job.phase = phase; }, opts.client === 'desktop')
      .then((result) => {
        if (!result.ok) {
          this.fail(job, result.reason, result.command, result.detail);
          return;
        }
        if (!result.installer) {
          job.phase = 'done';
          return;
        }
        const { dir, path, sha256 } = result.installer;
        if (this.job !== job) {
          void this.deps.removeDir(dir).catch(() => undefined);
          return;
        }
        const timer = setTimeout(() => {
          if (this.handoff?.sha256 !== sha256) return;
          this.dropHandoff();
          if (this.job === job && job.phase === 'handoff') {
            job.installer = null;
            this.fail(job, 'no_desktop', tailscaleManualInstallCommand(this.deps.platform), 'the Timon app did not open the installer');
          }
        }, HANDOFF_TIMEOUT_MS);
        timer.unref?.();
        this.handoff = { dir, sha256, timer };
        job.installer = { path, sha256 };
        job.phase = 'handoff';
      })
      .catch((err: unknown) => this.fail(job, 'installer_failed', null, firstLine((err as Error).message ?? '')));
    return this.status();
  }

  /**
   * `tailscale up`: brings a stopped node up, or prints the sign-in URL and
   * waits for the person to finish in their browser. Answers once the URL is
   * known (or after a short wait); `status()` notices the end.
   */
  async connect(): Promise<TailscaleSetupStatus> {
    if (this.busy()) return this.status();
    const binary = this.deps.binary();
    const job = this.start('connect', 'waiting_login');
    if (!binary) {
      this.fail(job, 'not_installed', null, null);
      return this.status();
    }
    const command = manualCommand(this.deps.platform, binary, ['up']);
    if (this.deps.platform === 'darwin' && appBundleOf(binary)) {
      await this.deps.launchApp(binary).catch(() => undefined);
    }

    let output = '';
    let up: UpProcess;
    try {
      up = this.deps.spawnUp(binary);
    } catch (err) {
      this.fail(job, 'failed', command, firstLine((err as Error).message ?? ''));
      return this.status();
    }
    this.stopUp();
    this.up = up;
    let settle: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => { settle = resolve; });
    const waiter = setTimeout(() => settle(), AUTH_URL_WAIT_MS);
    up.onOutput((chunk) => {
      if (output.length < OUTPUT_MAX) output += chunk;
      const url = authUrlIn(output);
      if (url && this.job === job && !job.authUrl) {
        job.authUrl = url;
        settle();
      }
    });
    up.onExit((code) => {
      if (this.up === up) this.stopUp();
      if (this.job === job && job.phase === 'waiting_login') {
        if (code === 0) job.phase = 'done';
        // Killed by us (sign-in seen, timeout): `status()` already decided.
        else if (code !== null) {
          const failure = classifyUpOutput(output);
          this.fail(job, failure, failure === 'permission' && this.deps.platform === 'linux' ? tailscaleManualOperatorCommand() : command, firstLine(output));
        }
      }
      settle();
    });
    this.upTimer = setTimeout(() => {
      if (this.job === job && job.phase === 'waiting_login') this.fail(job, 'failed', command, 'the sign-in was not completed in time');
      this.stopUp();
    }, LOGIN_TIMEOUT_MS);
    this.upTimer.unref?.();
    await answered;
    clearTimeout(waiter);
    return this.status();
  }

  /**
   * The desktop app's word on the installer it opened. Whatever it says, the
   * package is removed; the job only closes if it is still waiting on it.
   */
  async reportInstaller(report: InstallerReport): Promise<TailscaleSetupStatus> {
    if (!this.handoff || this.handoff.sha256 !== report.sha256) return this.status();
    this.dropHandoff();
    const job = this.job;
    if (job?.kind === 'install' && job.phase === 'handoff') {
      job.installer = null;
      const command = tailscaleManualInstallCommand(this.deps.platform);
      const detail = report.code === undefined ? null : `the installer exited with ${report.code}`;
      // The macOS Installer quits with 0 whether it installed or was closed: the machine decides.
      if (report.outcome === 'installed' && this.deps.binary()) job.phase = 'done';
      else if (report.outcome === 'failed') this.fail(job, 'installer_failed', command, detail);
      else this.fail(job, 'cancelled', command, detail);
    }
    return this.status();
  }

  /** Linux: `tailscale set --operator=<this account>`, elevated by pkexec. */
  async allowOperator(): Promise<TailscaleSetupStatus> {
    if (this.busy()) return this.status();
    const job = this.start('operator', 'installing');
    const binary = this.deps.binary();
    if (this.deps.platform !== 'linux') {
      this.fail(job, 'unsupported', null, null);
      return this.status();
    }
    if (!binary) {
      this.fail(job, 'not_installed', null, null);
      return this.status();
    }
    void this.deps.allowOperator(binary)
      .then((result) => {
        if (result.ok) job.phase = 'done';
        else this.fail(job, result.reason, result.command, result.detail);
      })
      .catch((err: unknown) => this.fail(job, 'failed', tailscaleManualOperatorCommand(), firstLine((err as Error).message ?? '')));
    return this.status();
  }

  /** Tests and shutdown: no `tailscale up` outlives its owner, no package its job. */
  dispose(): void {
    this.stopUp();
    this.dropHandoff();
  }
}

function upProcessOf(child: ChildProcess): UpProcess {
  return {
    onOutput: (listener) => {
      child.stdout?.on('data', (chunk: Buffer) => listener(chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString()));
    },
    onExit: (listener) => {
      child.on('error', () => listener(1));
      child.on('exit', (code) => listener(code));
    },
    kill: () => { child.kill(); },
  };
}

/** The real machine. */
export function hostSetupDeps(): TailscaleSetupDeps {
  const host = getHost();
  const platform = process.platform;
  const exec = (file: string, args: string[], timeoutMs: number) => host.execAsync(file, args, { timeout: timeoutMs, windowsHide: true });
  // The tailscale CLI itself: its environment comes from `host/tailscale-cli.ts` (TERM for the macOS bundle).
  const runCli = (binary: string, args: string[], timeoutMs: number) => host.execAsync(binary, args, tailscaleCliOpts(binary, { timeout: timeoutMs, windowsHide: true }));
  const fs = nodeInstallFs();
  const findBinary = (name: string) => whichBin(name, config().host.binaries).path;
  return {
    platform,
    binary: () => findBinary('tailscale'),
    run: runCli,
    spawnUp: (binary) => upProcessOf(host.spawn(binary, ['up'], tailscaleCliOpts(binary, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }))),
    install: (onPhase, delegate) => installTailscale({
      platform,
      arch: process.arch,
      ...fs,
      exec,
      desktopSession: () => host.gui?.desktopSession?.() ?? Promise.resolve('unknown'),
      findBinary,
      onPhase,
    }, { delegate }),
    removeDir: fs.removeDir,
    allowOperator: (binary) => allowTailscaleOperator({ exec, findBinary, username: fs.username }, binary),
    launchApp: async (binary) => {
      const app = appBundleOf(binary);
      // portability: macOS-only caller, the system `open`
      if (app) await exec('/usr/bin/open', ['-a', app], STATUS_TIMEOUT_MS);
    },
    now: () => Date.now(),
  };
}

let setup: TailscaleSetup | null = null;

export function tailscaleSetup(): TailscaleSetup {
  setup ??= new TailscaleSetup(hostSetupDeps());
  return setup;
}
