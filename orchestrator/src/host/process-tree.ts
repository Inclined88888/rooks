/**
 * The machine's process table, and what hangs under one process.
 *
 * Why it exists: the idle reaper has to tell a mission that is waiting for a
 * background job of its own (a test suite started with `run_in_background`)
 * from one that is really idle. The job is a child of the backend CLI, so the
 * question is "does anything run under this pid that was not there when the
 * CLI came up" — see `backgroundDescendants`.
 *
 * Reads only pid, parent pid and executable name, never a command line: those
 * carry credentials. Never throws; an unreadable table is an empty one, which
 * the reaper reads as "nothing in the background" (today's behaviour), never
 * as a reason to keep a mission alive.
 */
import { readdir, readFile } from 'node:fs/promises';
import type { Host } from './types.js';

export type ProcessEntry = { pid: number; ppid: number; name: string };

type TableHost = Pick<Host, 'platform' | 'execAsync'>;

/** Linux: `/proc/<pid>/stat` is `pid (comm) state ppid …`; `comm` may hold
 *  spaces and parentheses, so the fields are read after its LAST `)`. */
export function parseProcStat(stat: string): ProcessEntry | null {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(stat.slice(0, open).trim());
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
  return { pid, ppid, name: stat.slice(open + 1, close) };
}

/** `ps -A -o pid=,ppid=,comm=` (macOS and other Unix): `comm` can be a full
 *  path with spaces, so it is everything after the two numbers. */
export function parsePsOutput(stdout: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: baseName(m[3]!) });
  }
  return out;
}

/** Windows, from `ConvertTo-Csv` of `Win32_Process` (ProcessId, ParentProcessId, Name). */
export function parseCimCsv(stdout: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^"(\d+)","(\d+)","([^"]*)"\s*$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]! });
  }
  return out;
}

function baseName(path: string): string {
  // portability: splits a path printed by `ps`, which uses `/` only
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

async function readProcTable(): Promise<ProcessEntry[]> {
  // portability: Linux pseudo-fs, reached only behind the platform guard in readProcessTable
  const names = await readdir('/proc');
  const rows = await Promise.all(names.filter((n) => /^\d+$/.test(n)).map(async (n) => {
    try {
      // portability: Linux pseudo-fs, see above
      return parseProcStat(await readFile(`/proc/${n}/stat`, 'utf8'));
    } catch { return null; } // exited between readdir and read
  }));
  return rows.filter((r): r is ProcessEntry => r !== null);
}

const WINDOWS_TABLE_SCRIPT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation';

/** One snapshot of every process. Empty when the platform cannot say. */
export async function readProcessTable(host: TableHost): Promise<ProcessEntry[]> {
  try {
    if (host.platform === 'linux') return await readProcTable();
    if (host.platform === 'win32') {
      const r = await host.execAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TABLE_SCRIPT], { timeout: 10_000 });
      return r.code === 0 ? parseCimCsv(r.stdout.replace(/^\uFEFF/, '')) : [];
    }
    const r = await host.execAsync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { timeout: 5_000 });
    return r.code === 0 ? parsePsOutput(r.stdout) : [];
  } catch {
    return [];
  }
}

/** Every live process below `rootPid` (the root itself excluded). */
export function descendantsOf(table: readonly ProcessEntry[], rootPid: number): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const p of table) {
    const list = children.get(p.ppid);
    if (list) list.push(p); else children.set(p.ppid, [p]);
  }
  const out: ProcessEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const stack = [rootPid];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (seen.has(child.pid)) continue; // a recycled pid must not loop the walk
      seen.add(child.pid);
      out.push(child);
      stack.push(child.pid);
    }
  }
  return out;
}

/**
 * The process the backend CLI really is. A launcher pid is not always it: on
 * Windows a shim the adapter cannot start directly runs through `cmd.exe`
 * (`kill-tree.ts`), so the pid we hold is `cmd.exe` and the CLI is its only child.
 */
export function cliProcessPid(table: readonly ProcessEntry[], spawnedPid: number, platform: NodeJS.Platform): number {
  if (platform !== 'win32') return spawnedPid;
  let pid = spawnedPid;
  for (let hops = 0; hops < 4; hops++) {
    const self = table.find((p) => p.pid === pid);
    if (!self || self.name.toLowerCase() !== 'cmd.exe') break;
    const kids = descendantsOf(table, pid).filter((p) => p.ppid === pid);
    if (kids.length !== 1) break;
    pid = kids[0]!.pid;
  }
  return pid;
}

/**
 * What a mission's CLI runs for the CLI's own sake, taken once its MCP servers
 * are up: the direct children at that moment. Everything under them is the
 * CLI's plumbing (`npm exec …`, Chrome launched later by a browser MCP).
 */
export function cliBaseline(table: readonly ProcessEntry[], cliPid: number): number[] {
  return table.filter((p) => p.ppid === cliPid).map((p) => p.pid);
}

/**
 * The work the CLI started after its baseline: a shell of its Bash tool, and
 * whatever that shell runs. This is what keeps a mission "not idle" after its
 * turn ended with `run_in_background`.
 */
export function backgroundDescendants(
  table: readonly ProcessEntry[],
  cliPid: number,
  baseline: readonly number[],
): ProcessEntry[] {
  const plumbing = new Set(baseline);
  const byPid = new Map(table.map((e) => [e.pid, e]));
  return descendantsOf(table, cliPid).filter((p) => {
    // Walk up to the direct child of the CLI this process hangs under.
    let top = p;
    for (let hops = 0; top.ppid !== cliPid && hops < 64; hops++) {
      const parent = byPid.get(top.ppid);
      if (!parent) break;
      top = parent;
    }
    return !plumbing.has(top.pid);
  });
}
