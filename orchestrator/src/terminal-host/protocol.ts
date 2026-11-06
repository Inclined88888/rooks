/**
 * Terminal host — the wire between the daemon and the process that owns the
 * pseudo-terminals (`main.ts`).
 *
 * Why a separate process: a PTY dies with its parent. Living in the daemon,
 * every shell of the web terminal died at each daemon restart — including a
 * `systemctl --user restart timon-orchestrator` typed in that very shell,
 * which cut its own command in half. The host is launched outside the
 * daemon's supervisor (`host.spawnDetached`), keeps the shells across a
 * restart, and the daemon reconnects to it at boot.
 *
 * Channel: a Unix socket under `<TIMON_HOME>/run/` (0700 directory, 0600
 * socket), a named pipe on Windows. Only the daemon talks to the host; access
 * control stays in the daemon, the host trusts whoever proves the token.
 *
 * Frames: one JSON object per line, lines bounded (`MAX_LINE_BYTES`).
 *
 * Handshake — mutual, and the token never travels:
 *   host   → { t: 'hello', protocol, min, nonce }
 *   daemon → { t: 'auth', protocol, nonce, proof: HMAC(token, 'daemon:' + host nonce) }
 *   host   → { t: 'welcome', protocol, proof: HMAC(token, 'host:' + daemon nonce), build, entry, pid, sessions }
 *          | { t: 'denied', reason }
 * The host proving itself matters as much: on Windows a squatted pipe would
 * otherwise receive the keystrokes, `sudo` passwords included.
 *
 * Versions: `protocol` is the version the daemon picked inside both ranges,
 * or 0 when the ranges do not meet. Protocol 0 is the frozen base every host
 * and daemon will always speak — the handshake above plus the `stats` and
 * `shutdown` requests — so a newer daemon can always retire an idle host left
 * by an older release, and an older daemon a newer one. NEVER change those.
 *
 * Requests (after `welcome`): { t: 'req', id, op, ... } → { t: 'res', id, ok, result | error, message }.
 * An `attach` request dedicates its connection to one session: then
 *   daemon → { t: 'in', data } | { t: 'resize', cols, rows }
 *   host   → { t: 'out', data } | { t: 'exit', code }
 * and closing the connection detaches.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;

/** Output is cut into chunks this size, so a 200 000-character scrollback
 *  never makes a line anywhere near `MAX_LINE_BYTES` (JSON escapes a control
 *  character into six bytes). */
export const OUTPUT_CHUNK_CHARS = 32 * 1024;
export const MAX_LINE_BYTES = 1024 * 1024;

/** What the host announces about itself; the daemon retires an outdated, idle one. */
export type Welcome = {
  t: 'welcome';
  protocol: number;
  proof: string;
  build: string;
  entry: string;
  pid: number;
  sessions: number;
};

export type HostErrorCode = 'limit' | 'spawn' | 'bad_request' | 'not_found' | 'busy' | 'unsupported';

/** Same digest as `host/packaged-service.ts::instanceId`, kept here so the host
 *  process loads nothing but this folder. */
function instanceKey(home: string): string {
  return createHash('sha256').update(resolve(home)).digest('hex').slice(0, 24);
}

/**
 * `sun_path` holds 104 bytes on macOS and 108 on Linux, NUL included: a long
 * home (a test's temporary folder, a deep user directory) falls back to a
 * short private folder of the temporary directory, one per instance.
 */
const MAX_SOCKET_PATH_BYTES = 100;

export type HostFiles = {
  /** Unix socket path or Windows pipe name. */
  endpoint: string;
  /** Folder the daemon creates 0700 before the socket goes in (posix only). */
  endpointDir: string | null;
  token: string;
  log: string;
};

export function hostFiles(home: string, platform: NodeJS.Platform = process.platform): HostFiles {
  const run = join(home, 'run');
  const files = { token: join(run, 'terminal-host.token'), log: join(home, 'tmp', 'terminal-host.log') };
  if (platform === 'win32') {
    // A pipe name is global to the machine: the instance key keeps the
    // sandbox, the installed daemon and every test apart.
    // portability: a Windows pipe name, not a file path.
    return { ...files, endpoint: `\\\\.\\pipe\\timon-terminal-host-${instanceKey(home)}`, endpointDir: null };
  }
  const socket = join(run, 'terminal-host.sock');
  if (Buffer.byteLength(socket) <= MAX_SOCKET_PATH_BYTES) return { ...files, endpoint: socket, endpointDir: run };
  const dir = join(tmpdir(), `timon-th-${instanceKey(home).slice(0, 16)}`);
  return { ...files, endpoint: join(dir, 'host.sock'), endpointDir: dir };
}

export function newNonce(): string {
  return randomBytes(24).toString('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function proofOf(token: string, role: 'daemon' | 'host', nonce: string): string {
  return createHmac('sha256', token).update(`${role}:${nonce}`).digest('hex');
}

export function proofMatches(token: string, role: 'daemon' | 'host', nonce: string, proof: unknown): boolean {
  if (typeof proof !== 'string') return false;
  const expected = Buffer.from(proofOf(token, role, nonce), 'utf8');
  const given = Buffer.from(proof, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The version both sides speak, or 0 (the frozen base) when the ranges do not meet. */
export function negotiate(theirs: { protocol: number; min: number }, ours = { protocol: PROTOCOL_VERSION, min: MIN_PROTOCOL_VERSION }): number {
  const chosen = Math.min(theirs.protocol, ours.protocol);
  return chosen >= Math.max(theirs.min, ours.min) ? chosen : 0;
}

export function sendFrame(socket: Socket, frame: object): void {
  if (!socket.writable) return;
  socket.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Calls `onFrame` with each parsed line. A line over the limit, or one that is
 * not a JSON object, ends the connection: the other side is not speaking this
 * protocol.
 */
export function readFrames(socket: Socket, onFrame: (frame: Record<string, unknown>) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let frame: unknown;
      try { frame = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { socket.destroy(); return; }
      onFrame(frame as Record<string, unknown>);
      if (socket.destroyed) return;
      newline = buffer.indexOf('\n');
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) socket.destroy();
  });
}

export function chunksOf(data: string, size: number = OUTPUT_CHUNK_CHARS): string[] {
  if (data.length <= size) return [data];
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    let end = Math.min(data.length, i + size);
    // Never split a surrogate pair: each chunk becomes its own message downstream.
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}
