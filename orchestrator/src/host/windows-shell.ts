/**
 * Launching an npm shim (`codex.cmd`, `claude.cmd`) on Windows.
 *
 * Node refuses to `spawn()` a `.cmd`/`.bat` without a shell since the
 * CVE-2024-27980 fix: the call dies with `spawn EINVAL` before any process
 * exists. That is what a beta tester hit right after onboarding on Windows
 * (0.1.0, TIM-0009): `codex` installed from npm resolves to `codex.cmd`, and
 * every mission failed with a bare 500.
 *
 * `shell: true` would hand the raw arguments to cmd.exe unquoted, and a
 * prompt path or a `-c key=value` breaks on the first space. Instead we build
 * the command line ourselves, the way cross-spawn does, and run it through
 * `cmd.exe /d /s /c` with `windowsVerbatimArguments` so Node passes the
 * string as is. Real `.exe` binaries never go through here.
 *
 * `cmd.exe` also costs the CLI its death with the daemon: libuv keeps a direct
 * child in a kill-on-close job, but its job allows silent breakaway, so what
 * `cmd.exe` starts lives on as an orphan, under a pid the mission registry never
 * saw (TODO #603). `resolveNpmShim` reads what a shim would run, so the launch
 * can skip `cmd.exe` whenever the shim is one it recognises line for line.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, win32 } from 'node:path';

/** Characters cmd.exe interprets; each one is neutralised with `^`. */
const META = /([()\][%!^"`<>&|;, *?])/g;

export function needsCmdShell(file: string): boolean {
  const ext = extname(file).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

function escapeCommand(arg: string): string {
  return arg.replace(META, '^$1');
}

/**
 * One argument, quoted for the C runtime's parser THEN for cmd.exe. A shim
 * re-parses its line once more, hence the double escaping of the metas.
 */
export function escapeArgument(arg: string, doubleEscape: boolean): string {
  let out = `${arg}`;
  // Backslashes before a quote are literal only if doubled; then escape the quote.
  out = out.replace(/(\\*)"/g, '$1$1\\"');
  // Trailing backslashes would otherwise escape our closing quote.
  out = out.replace(/(\\*)$/, '$1$1');
  out = `"${out}"`;
  out = out.replace(META, '^$1');
  if (doubleEscape) out = out.replace(META, '^$1');
  return out;
}

export type ShellLaunch = {
  file: string;
  args: string[];
  windowsVerbatimArguments: true;
};

/**
 * How to launch `file` with `args` when it is a shim, or `null` when the
 * caller can spawn it directly. Pure: the platform is a parameter so the
 * quoting is testable from Linux.
 */
export function windowsShimLaunch(
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env.comspec,
): ShellLaunch | null {
  if (platform !== 'win32' || !needsCmdShell(file)) return null;
  const command = [escapeCommand(file), ...args.map((a) => escapeArgument(a, true))].join(' ');
  return {
    file: comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${command}"`],
    windowsVerbatimArguments: true,
  };
}

/** What an npm shim runs once `cmd.exe` is out of the way. */
export type NpmShimTarget =
  | {
    kind: 'script';
    runtime: 'node' | 'bun';
    /** `<runtime>.exe` beside the shim, which the shim prefers to the one on PATH. */
    runtimeBeside: string | null;
    script: string;
  }
  | { kind: 'program'; program: string };

export type NpmShimOptions = {
  read?: (file: string) => string;
  isFile?: (file: string) => boolean;
};

/** cmd-shim writes about 500 bytes: anything much larger is not one of its shims. */
const MAX_SHIM_BYTES = 16 * 1024;

const DP0 = '%(?:dp0%|~dp0)';
const SCRIPT = `"${DP0}\\\\([^"]+)"`;

/** Lines of the known shims that start nothing and change nothing the target sees. */
const SHIM_PLUMBING = /^(?:echo off|goto start|:start|:find_dp0|call :find_dp0|set dp0=%~dp0|setlocal|endlocal|exit \/b(?: %errorlevel%)?|\) else \(|\)|set pathext=%pathext:;\.js;=;%)$/i;
/** The lines that pick the runtime; every one of them must name the same. */
const SHIM_RUNTIME = [
  new RegExp(`^if exist "${DP0}\\\\(node|bun)\\.exe" \\($`, 'i'),
  new RegExp(`^set "_prog=${DP0}\\\\(node|bun)\\.exe"$`, 'i'),
  /^set "_prog=(node|bun)"$/i,
];
/** npm's prefix that keeps a console from asking "Terminate batch job?". */
const SHIM_HANDOFF = /^endlocal & goto #_undefined_# 2>nul \|\| title %comspec% & /i;
const SHIM_RUN_PROG = new RegExp(`^"%_prog%"\\s+${SCRIPT}\\s+%\\*$`, 'i');
const SHIM_RUN_BESIDE = new RegExp(`^"${DP0}\\\\(node|bun)\\.exe"\\s+${SCRIPT}\\s+%\\*$`, 'i');
const SHIM_RUN_BARE = new RegExp(`^(node|bun)\\s+${SCRIPT}\\s+%\\*$`, 'i');
const SHIM_RUN_PROGRAM = new RegExp(`^${SCRIPT}\\s+%\\*$`, 'i');

/** Extensions a runtime cannot run: such a target is a shell's business. */
const NOT_A_SCRIPT = new Set(['.cmd', '.bat', '.ps1', '.exe', '.com']);

/**
 * The path segments under the shim's folder, or null for anything that could
 * lead out of it. Windows drops the trailing dots and spaces of a segment, so
 * `.. ` is `..`; the character list leaves out `:` (a drive, a stream) and all
 * that cmd.exe or a variable expansion would interpret.
 */
function segmentsUnderShim(relative: string): string[] | null {
  if (!/^[\w@.+~ \\/-]+$/.test(relative)) return null;
  const segments = relative.split(/[\\/]/).filter((segment) => segment !== '.');
  if (segments.length === 0) return null;
  return segments.every((segment) => segment !== '' && !/[. ]$/.test(segment)) ? segments : null;
}

function readShim(file: string): string {
  if (statSync(file).size > MAX_SHIM_BYTES) throw new Error('not a shim');
  return readFileSync(file, 'utf8');
}

/**
 * What the shim `file` runs, or null when it is not a format we know: npm's
 * cmd-shim (current and older), the variant pnpm writes without a
 * NODE_PATH, each to a `node` or `bun` script or to an `.exe`. Null sends the
 * caller back to `cmd.exe`, which is why anything unsure is refused, whether
 * forged or merely new: a pnpm shim that sets NODE_PATH, a yarn shim calling
 * another `.cmd`, a target out of the shim's folder, a shim with flags for the
 * runtime. Every line must be accounted for, so nothing a shim adds can be
 * skipped silently, and this never runs more than the shim itself could.
 */
export function resolveNpmShim(file: string, options: NpmShimOptions = {}): NpmShimTarget | null {
  if (!needsCmdShell(file)) return null;
  if (!win32.isAbsolute(file) && !isAbsolute(file)) return null;
  // A drive path is read the Windows way on any OS: that is how tests reach it.
  const path = isAbsolute(file) ? { dirname, join } : win32;
  const isFile = options.isFile ?? ((candidate: string) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
  let text: string;
  try { text = (options.read ?? readShim)(file); } catch { return null; }

  const runtimes = new Set<string>();
  const scripts = new Set<string>();
  const programs = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^@/, '').trim().replace(SHIM_HANDOFF, '');
    if (!line || SHIM_PLUMBING.test(line)) continue;
    const picked = SHIM_RUNTIME.map((pattern) => pattern.exec(line)).find(Boolean);
    if (picked) { runtimes.add(picked[1]!.toLowerCase()); continue; }
    const viaProg = SHIM_RUN_PROG.exec(line);
    if (viaProg) { scripts.add(viaProg[1]!); continue; }
    const named = SHIM_RUN_BESIDE.exec(line) ?? SHIM_RUN_BARE.exec(line);
    if (named) { runtimes.add(named[1]!.toLowerCase()); scripts.add(named[2]!); continue; }
    const program = SHIM_RUN_PROGRAM.exec(line);
    if (program) { programs.add(program[1]!); continue; }
    return null;
  }

  const dir = path.dirname(file);
  const under = (relative: string): string | null => {
    const segments = segmentsUnderShim(relative);
    if (!segments) return null;
    const target = path.join(dir, ...segments);
    return isFile(target) ? target : null;
  };
  if (programs.size === 1 && scripts.size === 0 && runtimes.size === 0) {
    const [relative] = programs;
    if (extname(relative!.replace(/\\/g, '/')).toLowerCase() !== '.exe') return null;
    const program = under(relative!);
    return program ? { kind: 'program', program } : null;
  }
  if (programs.size !== 0 || scripts.size !== 1 || runtimes.size !== 1) return null;
  const [relative] = scripts;
  const [runtime] = runtimes;
  if (NOT_A_SCRIPT.has(extname(relative!.replace(/\\/g, '/')).toLowerCase())) return null;
  const script = under(relative!);
  if (!script) return null;
  const beside = path.join(dir, `${runtime!}.exe`);
  return { kind: 'script', runtime: runtime as 'node' | 'bun', runtimeBeside: isFile(beside) ? beside : null, script };
}

/**
 * The launch of a shim without `cmd.exe`, or `null` when it needs one: not a
 * shim, not one `resolveNpmShim` knows, or no runtime that can be started
 * directly (a `node.cmd` from a version manager is one more shim). The CLI is
 * then this daemon's direct child: inside libuv's job, and under the pid the
 * mission registry records. `findRuntime` is the adapter's own lookup, the one
 * that also fills a mission's PATH (`launch-path.ts`).
 */
export function windowsDirectLaunch(
  file: string,
  args: readonly string[],
  options: NpmShimOptions & {
    findRuntime: (name: 'node' | 'bun') => string | null;
    platform?: NodeJS.Platform;
  },
): { file: string; args: string[] } | null {
  if ((options.platform ?? process.platform) !== 'win32') return null;
  const target = resolveNpmShim(file, options);
  if (!target) return null;
  if (target.kind === 'program') return { file: target.program, args: [...args] };
  const runtime = target.runtimeBeside ?? options.findRuntime(target.runtime);
  if (!runtime || needsCmdShell(runtime)) return null;
  return { file: runtime, args: [target.script, ...args] };
}
