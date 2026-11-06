/**
 * Opening of the NATIVE terminal of the machine hosting the orchestrator.
 *
 * This is deliberately NOT a web emulator (xterm.js + pty + WebSocket):
 * the TIMON UI has no application authentication — the only boundary is
 * Tailscale — so exposing a shell in the browser would amount to publishing
 * a root shell on the tailnet. Here we simply launch the terminal application
 * already installed (Hyper by default) on a known folder: The user keeps
 * their config, their history and their sudo, and nothing new is exposed.
 *
 * Two guards:
 *  — the `TIMON_TERMINAL_ENABLED` setting switches the feature off in one step;
 *  — `isKnownCwd()` allows ONLY the paths TIMON already knows (an agent's
 *    cwd, a task's worktree). The path comes from the client: even if a `spawn`
 *    without a shell rules out injection, opening an arbitrary folder of the disk
 *    has no reason to be allowed.
 */
import { existsSync, realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { listAgents } from './agent.js';
import { dbApi } from './db.js';
import { getHost } from './host/index.js';
import { settingBool, settingStr } from './settings.js';

export function isTerminalEnabled(): boolean {
  return settingBool('TIMON_TERMINAL_ENABLED');
}

export function terminalCommand(): string {
  return settingStr('TIMON_TERMINAL_COMMAND').trim() || 'hyper';
}

/** A desktop terminal can be opened: a host may show a file manager (Windows,
 *  macOS) without being able to open a terminal. */
export function hostHasGui(): boolean {
  return typeof getHost().gui?.openTerminal === 'function';
}

export type TerminalDisabledReason = 'no_gui' | 'disabled';

/** What GET /api/terminal advertises. `enabled` is false when the host has
 *  no `gui` (macOS/Windows today) even if `TIMON_TERMINAL_ENABLED` is on —
 *  otherwise the UI offers an action that can only 4xx/500. */
export function terminalStatus(): {
  enabled: boolean;
  command: string;
  reason?: TerminalDisabledReason;
} {
  const command = terminalCommand();
  if (!hostHasGui()) return { enabled: false, command, reason: 'no_gui' };
  if (!isTerminalEnabled()) return { enabled: false, command, reason: 'disabled' };
  return { enabled: true, command };
}

/** Canonical form of a path for comparison: absolute, symlinks resolved
 *  when the folder exists (a worktree may live under a link), without a trailing
 *  slash. Returns null for anything that is not a usable absolute path. */
function canon(p: string | null | undefined): string | null {
  if (typeof p !== 'string') return null;
  const trimmed = p.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  const abs = resolvePath(trimmed);
  try {
    return existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

/** Does the path match an agent's cwd or a task's worktree? */
export function isKnownCwd(cwd: string): boolean {
  const target = canon(cwd);
  if (!target) return false;

  try {
    for (const a of listAgents()) {
      if (canon(a.cwd) === target) return true;
    }
  } catch {
    /* agents folder unreadable: carry on with the tasks */
  }

  try {
    for (const t of dbApi.listTasks()) {
      if (canon(t.worktree_path) === target) return true;
    }
  } catch {
    /* database unavailable: refused by default */
  }
  return false;
}

export type OpenResult =
  | { ok: true }
  | { ok: false; error: string; reason?: TerminalDisabledReason };

/**
 * Launches the terminal on `cwd`. The path MUST have been validated by
 * `isKnownCwd()` upstream.
 *
 * Goes through `systemd-run --user`, NOT through a detached spawn. The
 * `timon-orchestrator` unit runs with `KillMode=control-group` (the default): every
 * process spawned by the orchestrator lives in ITS cgroup and receives the SIGTERM
 * of a `systemctl restart`. `detached: true` opens a new session but does
 * not leave the cgroup. The window therefore closed at every restart of
 * the orchestrator — including, and above all, when the command just
 * pasted into it WAS that restart: the terminal killed itself in the middle of its own
 * command, without letting the result be seen. A transient unit gives it its
 * own cgroup, it survives.
 *
 * No `--unit=`: systemd is left to name the unit, otherwise two simultaneous
 * openings would fight over the same name. `--collect` cleans the unit up when it
 * exits.
 *
 * The exit code of `systemd-run` only says whether the unit was accepted,
 * which is enough: the terminal itself is asynchronous, and Hyper (single-instance
 * Electron) delegates to the existing instance then exits right away — an
 * immediate exit 0 is not a failure.
 */
export function openTerminal(cwd: string): OpenResult {
  const gui = getHost().gui;
  if (gui?.openTerminal) {
    try {
      gui.openTerminal(cwd);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  // No local fallback: the detached-spawn path lives in the host adapter.
  // Without `gui` there is no desktop to open a window on — say so rather
  // than opening one nobody can see.
  return { ok: false, error: 'host has no gui capability', reason: 'no_gui' };
}
