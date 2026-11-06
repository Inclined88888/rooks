/**
 * Timon's own log files (TODO #343): one file per kind and per local day,
 * every line stamped with the local time and its offset, old days and excess
 * size deleted.
 *
 * Why dated files written by the process itself rather than the supervisor's
 * redirection alone: launchd appends to `daemon.log` with no limit, the
 * Windows launcher rotates once at 10 MB, the app's embedded daemon writes to
 * an Electron stdout nobody reads, and no supervisor stamps a line. The
 * redirection stays: it catches what precedes this module (a crash at import)
 * and what Node prints itself when it dies.
 *
 * The files stay chronological, appended to. Newest-first is a question of
 * display (`readRecentLines`): rewriting a file at every line would race the
 * other writer, lose the file on a crash and break `tail`.
 *
 * No import beyond Node: the desktop (`desktop/src/desktop-log.ts`) keeps a
 * copy of the naming and stamping, held together by a test, and the
 * diagnostic runner reads these files with no database loaded.
 */
import {
  closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync,
  truncateSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type LogKind = 'daemon' | 'desktop' | 'prompts';
export type LogLimits = { days: number; maxBytes: number };

export const DEFAULT_LOG_RETENTION_DAYS = 14;
export const DEFAULT_LOG_MAX_MB = 200;
/** A single dated file never grows past this: the writer opens the next part. */
export const LOG_PART_BYTES = 10 * 1024 * 1024;
const MB = 1024 * 1024;
/** Same ceiling as the Windows launcher's rotation (`WINDOWS_LOG_ROTATE_BYTES`). */
export const SUPERVISOR_LOG_MAX_BYTES = 10 * MB;

/** Same folder as the supervisor's `daemon.log`: one folder to open, one to send. */
export function logDir(home: string): string {
  return join(home, 'tmp');
}

/** The file a launchd job or the Windows launcher appends the daemon's output to. */
export function supervisorLogFile(home: string): string {
  return join(logDir(home), 'daemon.log');
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `2026-10-13`, in the machine's time zone. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `2026-10-13T19:06:11.123+02:00`: local, so a tester reads their own clock, with
 *  the offset, so the line still means one instant once it is pasted elsewhere. */
export function localTimestamp(date: Date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${localDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function datedLogName(kind: LogKind, day: string, part = 1): string {
  return part > 1 ? `${kind}-${day}.${part}.log` : `${kind}-${day}.log`;
}

const DATED = /^(daemon|desktop|prompts)-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;

export function parseDatedLog(name: string): { kind: LogKind; day: string; part: number } | null {
  const match = DATED.exec(name);
  if (!match) return null;
  return { kind: match[1] as LogKind, day: match[2]!, part: match[3] ? Number(match[3]) : 1 };
}

function positiveInt(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number >= 0 ? number : null;
}

/**
 * Limits readable before the database: the environment, then the `settings`
 * section of `timon.config.json` — the order of `settings.ts`. Its table layer
 * is applied once the daemon has opened the database (`setLogLimits`).
 */
export function limitsFromFiles(home: string, env: NodeJS.ProcessEnv = process.env): LogLimits {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'timon.config.json'), 'utf8')) as { settings?: unknown };
    if (parsed.settings && typeof parsed.settings === 'object') settings = parsed.settings as Record<string, unknown>;
  } catch { /* No config yet, or unreadable: the defaults. */ }
  const days = positiveInt(env.TIMON_LOG_RETENTION_DAYS) ?? positiveInt(settings.TIMON_LOG_RETENTION_DAYS) ?? DEFAULT_LOG_RETENTION_DAYS;
  const mb = positiveInt(env.TIMON_LOG_MAX_MB) ?? positiveInt(settings.TIMON_LOG_MAX_MB) ?? DEFAULT_LOG_MAX_MB;
  return { days, maxBytes: mb * MB };
}

/** The day `days` before `today`, as `YYYY-MM-DD`. */
function dayBefore(today: Date, days: number): string {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
  return localDay(date);
}

/**
 * Deletes the dated files older than `limits.days` (0 = no age limit), then
 * the oldest until the whole set fits in `limits.maxBytes` (0 = no ceiling).
 * `keep` names the files being written: never deleted, even when alone over
 * the ceiling. A file Windows holds open is skipped and tried again at the
 * next purge. Returns the names deleted.
 */
export function purgeLogs(dir: string, limits: LogLimits, now: Date = new Date(), keep: ReadonlySet<string> = new Set()): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const files = names.flatMap((name) => {
    const parsed = parseDatedLog(name);
    if (!parsed) return [];
    try { return [{ name, ...parsed, size: statSync(join(dir, name)).size }]; } catch { return []; }
  }).sort((a, b) => a.day.localeCompare(b.day) || a.part - b.part);
  const removed: string[] = [];
  const remove = (name: string): boolean => {
    if (keep.has(name)) return false;
    try { unlinkSync(join(dir, name)); removed.push(name); return true; } catch { return false; }
  };
  const cutoff = limits.days > 0 ? dayBefore(now, limits.days) : null;
  let remaining = files.filter((file) => !(cutoff !== null && file.day < cutoff && remove(file.name)));
  if (limits.maxBytes > 0) {
    let total = remaining.reduce((sum, file) => sum + file.size, 0);
    for (const file of [...remaining]) {
      if (total <= limits.maxBytes) break;
      if (remove(file.name)) {
        total -= file.size;
        remaining = remaining.filter((other) => other !== file);
      }
    }
  }
  return removed;
}

/**
 * The supervisor's `daemon.log` keeps growing under launchd. Its writer holds
 * it with `O_APPEND`, so truncating in place is safe there; the tail goes to
 * `daemon.log.1` first. Windows is left alone: its launcher rotates the file
 * at start, and the redirection may hold it locked.
 */
export function trimSupervisorLog(file: string, maxBytes: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32' || maxBytes <= 0) return false;
  try {
    const size = statSync(file).size;
    if (size <= maxBytes) return false;
    const keep = Math.floor(maxBytes / 2);
    const fd = openSync(file, 'r');
    const buffer = Buffer.alloc(keep);
    try { readSync(fd, buffer, 0, keep, size - keep); } finally { closeSync(fd); }
    writeFileSync(`${file}.1`, buffer);
    truncateSync(file, 0);
    return true;
  } catch {
    return false;
  }
}

/** Prefixes `stamp` at every line start of `text`; `state` carries a line cut between two chunks. */
export function stampLines(text: string, stamp: string, state: { lineStart: boolean }): string {
  let out = '';
  for (const piece of text.split(/(?<=\n)/)) {
    if (piece === '') continue;
    out += state.lineStart ? `${stamp} ${piece}` : piece;
    state.lineStart = piece.endsWith('\n');
  }
  return out;
}

/**
 * Appends to `<dir>/<kind>-<day>[.<part>].log`, switching file at midnight
 * and past `LOG_PART_BYTES`. Never throws: a full disk must not stop the
 * process it logs; `write` returns false and the caller echoes instead.
 */
export class DatedLogWriter {
  private fd: number | null = null;
  private name = '';
  private day = '';
  private part = 1;
  private size = 0;

  constructor(
    private readonly dir: string,
    private readonly kind: LogKind,
    private readonly onOpen: (name: string) => void = () => {},
    private readonly now: () => Date = () => new Date(),
    private readonly partBytes = LOG_PART_BYTES,
  ) {}

  get current(): string { return this.name; }

  write(text: string): boolean {
    try {
      const day = localDay(this.now());
      const bytes = Buffer.byteLength(text);
      if (this.fd === null || day !== this.day) this.open(day, 1);
      else if (this.size > 0 && this.size + bytes > this.partBytes) this.open(day, this.part + 1);
      writeSync(this.fd!, text);
      this.size += bytes;
      return true;
    } catch {
      this.close();
      return false;
    }
  }

  close(): void {
    if (this.fd !== null) {
      try { closeSync(this.fd); } catch { /* already gone */ }
    }
    this.fd = null;
  }

  private open(day: string, from: number): void {
    this.close();
    mkdirSync(this.dir, { recursive: true });
    // Resume the last part of the day after a restart rather than start a new one.
    let part = from;
    while (existsSync(join(this.dir, datedLogName(this.kind, day, part + 1)))) part += 1;
    let name = datedLogName(this.kind, day, part);
    if (existsSync(join(this.dir, name)) && statSync(join(this.dir, name)).size >= this.partBytes) {
      part += 1;
      name = datedLogName(this.kind, day, part);
    }
    this.fd = openSync(join(this.dir, name), 'a');
    this.size = fstatSync(this.fd).size;
    this.day = day;
    this.part = part;
    this.name = name;
    this.onOpen(name);
  }
}

let limitsSource: () => LogLimits = () => ({ days: DEFAULT_LOG_RETENTION_DAYS, maxBytes: DEFAULT_LOG_MAX_MB * MB });
let installed: { dir: string; writer: DatedLogWriter } | null = null;

/** Swaps where the limits come from (the daemon's settings, once its database is open) and purges with them. */
export function setLogLimits(source: () => LogLimits): void {
  limitsSource = source;
  if (installed) purgeLogs(installed.dir, safeLimits(), new Date(), new Set([installed.writer.current]));
}

function safeLimits(): LogLimits {
  try { return limitsSource(); } catch { return { days: DEFAULT_LOG_RETENTION_DAYS, maxBytes: DEFAULT_LOG_MAX_MB * MB }; }
}

function stdoutIsFile(fd: number): boolean {
  try { return fstatSync(fd).isFile(); } catch { return false; }
}

type Write = typeof process.stdout.write;

/**
 * Routes everything the process prints through stdout/stderr into its dated
 * file, stamped. The original stream still gets the stamped line, except when
 * it is itself a file (a launchd or Windows redirection): the same lines twice,
 * one copy with no limit, is what this module exists to stop.
 */
export function installProcessLog(opts: { home: string; kind: LogKind; limits?: () => LogLimits }): { writer: DatedLogWriter; restore: () => void } {
  if (opts.limits) limitsSource = opts.limits;
  const dir = logDir(opts.home);
  const writer = new DatedLogWriter(dir, opts.kind, (name) => {
    purgeLogs(dir, safeLimits(), new Date(), new Set([name]));
  });
  installed = { dir, writer };
  if (opts.kind === 'daemon') trimSupervisorLog(supervisorLogFile(opts.home), SUPERVISOR_LOG_MAX_BYTES);
  const restores: (() => void)[] = [];
  for (const [stream, fd] of [[process.stdout, 1], [process.stderr, 2]] as const) {
    const original = stream.write.bind(stream) as Write;
    const echo = !stdoutIsFile(fd);
    const state = { lineStart: true };
    const decoder = new StringDecoder('utf8');
    const patched = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
      const done = typeof encoding === 'function' ? encoding : typeof callback === 'function' ? callback : undefined;
      const text = typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? decoder.write(Buffer.from(chunk)) : String(chunk);
      const stamped = stampLines(text, localTimestamp(), state);
      const saved = writer.write(stamped);
      if (echo || !saved) return original(stamped, done as (error?: Error | null) => void);
      if (done) queueMicrotask(() => (done as () => void)());
      return true;
    }) as Write;
    stream.write = patched;
    restores.push(() => { stream.write = original; });
  }
  // Node prints a fatal error straight to the file descriptor, past `write`.
  const fatal = (error: unknown): void => {
    writer.write(`${localTimestamp()} [fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  };
  process.on('uncaughtExceptionMonitor', fatal);
  return {
    writer,
    restore: () => {
      for (const restore of restores) restore();
      process.off('uncaughtExceptionMonitor', fatal);
      writer.close();
      installed = null;
    },
  };
}

/** One-off append to a dated file of another kind (`prompts`), stamped. */
export function appendDatedLog(home: string, kind: LogKind, text: string): string | null {
  const dir = logDir(home);
  const writer = new DatedLogWriter(dir, kind);
  try {
    const body = text.endsWith('\n') ? text : `${text}\n`;
    return writer.write(`${localTimestamp()} ${body}`) ? join(dir, writer.current) : null;
  } finally {
    writer.close();
  }
}

/**
 * The last `count` lines of a kind, newest first, across its dated files.
 * Reads backwards a file at a time, so a 10 MB file costs its tail only.
 */
export function readRecentLines(dir: string, kind: LogKind, count: number): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const files = names.flatMap((name) => {
    const parsed = parseDatedLog(name);
    return parsed && parsed.kind === kind ? [{ name, ...parsed }] : [];
  }).sort((a, b) => b.day.localeCompare(a.day) || b.part - a.part);
  const lines: string[] = [];
  for (const file of files) {
    lines.push(...tailLines(join(dir, file.name), count - lines.length).reverse());
    if (lines.length >= count) break;
  }
  return lines;
}

/** The last `count` non-empty lines of a file, oldest first. */
export function tailLines(file: string, count: number, maxBytes = 512 * 1024): string[] {
  if (count <= 0) return [];
  try {
    const size = statSync(file).size;
    const length = Math.min(size, maxBytes);
    const fd = openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
    const lines = buffer.toString('utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    // A read that started mid-file starts mid-line: drop that fragment.
    if (length < size) lines.shift();
    return lines.slice(-count);
  } catch {
    return [];
  }
}
