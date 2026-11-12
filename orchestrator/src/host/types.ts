import type {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import type { DetachedResult, DetachedSpec } from './detached.js';
import type { IsolationTarget, LauncherKind } from './isolation.js';
import type { ListenPortState } from './listen-port.js';
import type { DesktopSession } from './desktop-session.js';

export type Capability = 'systemd' | 'containers' | 'traefik' | 'gui' | 'git' | 'grepai' | 'uvx' | 'keyring';

/** The lane a reveal actually took — what the UI can tell a user when nothing opened. */
export type RevealVia = 'filemanager1' | 'xdg-open' | 'explorer' | 'finder';

export type ExecOpts = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'>;
export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** `execAsync` only: the `timeout` stopped the command, so `code` is not its
   *  answer. A caller that reads a failure as a fact needs the difference. */
  timedOut?: boolean;
};
export type SpawnOpts = SpawnOptions;

/**
 * OS keyring, under a single service name (`rooks`). Optional on purpose: the
 * Secret Service is locked as long as no graphical session is unlocked and does
 * not exist at all on a VPS, so a headless daemon must work without it
 * (`docs/SECRETS-VAULT.md` §4.3). It shelters the master key, never the secrets.
 */
export interface Keyring {
  /** The stored value, or `undefined` when the account holds nothing. Throws
   *  when the keyring answers an actual error — an unreadable keyring must not
   *  look like an empty one. */
  get(account: string): string | undefined;
  set(account: string, value: string): void;
  del(account: string): void;
}

export interface Host {
  inspectPort?: (address: string, port: number) => ListenPortState | Promise<ListenPortState>;
  platform: 'linux' | 'darwin' | 'win32';
  capabilities(): Capability[];
  bin(name: string): string;
  exec(name: string, args: string[], opts?: ExecOpts): ExecResult;
  execAsync(name: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;
  spawn(name: string, args: string[], opts?: SpawnOpts): ChildProcess;
  /** Wraps a mission command in a resource-capped, optionally filesystem-masked
   *  launcher. `target` says which paths must stay reachable (mission `cwd`,
   *  backend credentials); omitting it only costs masking, never correctness. */
  confine(
    cmd: string,
    args: string[],
    unit: string,
    target?: IsolationTarget,
  ): { cmd: string; args: string[] };
  services: {
    start(unit: string, cmd: string, args: string[], cwd: string): void;
    stop(unit: string): void;
    status(unit: string): 'running' | 'stopped';
    self(): { status: string; since?: number };
    selfRestart(): void;
  };
  containers?: { cli(args: string[], timeoutMs?: number): ExecResult };
  /**
   * How far this host can confine a mission's filesystem, and the hook for the
   * boundary that would actually hold (audit finding #4, `docs/SECURITY.md`
   * §9.1).
   *
   * `launcher` is the unit kind missions are wrapped in: only a kind systemd
   * itself executes carries the `Exec*` masking directives, and a `scope` does
   * not. `runAs` is declared and NOT implemented — running a mission under a
   * dedicated OS account or in a namespace needs a privileged helper Rooks does
   * not ship; the field exists so the extension point has one name across
   * platforms rather than being invented three times.
   */
  isolation?: {
    launcher: LauncherKind;
    /** Paths this host will mask for such a launch; empty when it masks none. */
    masked(target?: IsolationTarget): readonly string[];
    runAs?: (user: string) => never;
  };
  /** `openTerminal` is absent where the OS can show a file manager but this
   *  adapter cannot open a terminal (Windows, macOS): `terminalStatus()` then
   *  answers `no_gui` instead of offering an action that can only fail. */
  gui?: {
    openTerminal?(cwd: string): void;
    reveal(path: string): Promise<RevealVia>;
    /** Absent where `gui` exists only because a display was probed (Linux): the
     *  session is then known to be graphical. Windows and macOS always carry
     *  `gui` — the daemon may run in a service session with no desktop — and
     *  answer here. */
    desktopSession?(): Promise<DesktopSession>;
  };
  keyring?: Keyring;
  /**
   * Starts a process that outlives the daemon AND the service manager
   * stopping it — the terminal host keeps the web shells across a restart.
   * How each OS escapes its supervisor: `host/detached.ts`.
   */
  spawnDetached?(spec: DetachedSpec): Promise<DetachedResult>;
}
