/**
 * The desktop's own log (TODO #343): `<home>/tmp/desktop-<day>.log`, every
 * line stamped. A packaged app has no console: its `console.error` calls on a
 * failed update or a daemon that does not answer went nowhere.
 *
 * Everything between the two `--- copy ---` marks is a verbatim copy of
 * `orchestrator/src/log-file.ts`: the two packages build separately, and the
 * daemon's purge and the diagnostic report read these files by the same
 * names. `desktop-log.test.ts` holds the copy to its source.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// --- copy of orchestrator/src/log-file.ts ---
export type LogKind = 'daemon' | 'desktop' | 'prompts';
export type LogLimits = { days: number; maxBytes: number };

export const DEFAULT_LOG_RETENTION_DAYS = 14;
export const DEFAULT_LOG_MAX_MB = 200;
/** A single dated file never grows past this: the writer opens the next part. */
export const LOG_PART_BYTES = 10 * 1024 * 1024;
const MB = 1024 * 1024;

/** Same folder as the supervisor's `daemon.log`: one folder to open, one to send. */
export function logDir(home: string): string {
  return join(home, 'tmp');
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
 * section of `rooks.config.json` — the order of `settings.ts`. Its table layer
 * is applied once the daemon has opened the database (`setLogLimits`).
 */
export function limitsFromFiles(home: string, env: NodeJS.ProcessEnv = process.env): LogLimits {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'rooks.config.json'), 'utf8')) as { settings?: unknown };
    if (parsed.settings && typeof parsed.settings === 'object') settings = parsed.settings as Record<string, unknown>;
  } catch { /* No config yet, or unreadable: the defaults. */ }
  const days = positiveInt(env.ROOKS_LOG_RETENTION_DAYS) ?? positiveInt(settings.ROOKS_LOG_RETENTION_DAYS) ?? DEFAULT_LOG_RETENTION_DAYS;
  const mb = positiveInt(env.ROOKS_LOG_MAX_MB) ?? positiveInt(settings.ROOKS_LOG_MAX_MB) ?? DEFAULT_LOG_MAX_MB;
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

// --- end of copy ---

/**
 * Routes what the main process prints into its dated file, stamped, and
 * still to the original stream (a terminal when run by hand). Returns the
 * writer, closed on quit by the caller.
 */
export function installDesktopLog(home: string): DatedLogWriter {
  const dir = logDir(home);
  const writer = new DatedLogWriter(dir, 'desktop', (name) => {
    purgeLogs(dir, limitsFromFiles(home), new Date(), new Set([name]));
  });
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as typeof stream.write;
    const state = { lineStart: true };
    const decoder = new StringDecoder('utf8');
    stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
      const done = typeof encoding === 'function' ? encoding : typeof callback === 'function' ? callback : undefined;
      const text = typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? decoder.write(Buffer.from(chunk)) : String(chunk);
      const stamped = stampLines(text, localTimestamp(), state);
      writer.write(stamped);
      try {
        return original(stamped, done as (error?: Error | null) => void);
      } catch {
        // No console behind a packaged GUI app: the file is what counts.
        if (done) queueMicrotask(() => (done as () => void)());
        return true;
      }
    }) as typeof stream.write;
  }
  return writer;
}
