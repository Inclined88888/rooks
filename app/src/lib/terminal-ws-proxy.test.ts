/**
 * The terminal WebSocket proxy decides nothing — the daemon does. What it
 * must get right: forward only our session cookie, tell the daemon which
 * host the browser reached (the Origin check depends on it), and pass a
 * refusal's status through instead of hanging the socket.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The daemon's own verifier: the relay and the daemon must agree on it. */
interface DaemonProof {
  verifyRelayProof(value: string | string[] | undefined, daemonToken: string, machineId: string): boolean;
}

const DAEMON_TOKEN = 'daemon-token-of-this-test-home';
const CREDENTIAL_PATH = /^\/api\/machines\/([^/]+)\/credential$/;
let proof: DaemonProof;
let home = '';

const seen: http.IncomingHttpHeaders[] = [];
const lookups: string[] = [];
// The fleet's `/credential`, checked in the real route's order: the proof
// before the row, so a 404 can only come back to a relay holding the key.
const daemon = http.createServer((req, res) => {
  const id = CREDENTIAL_PATH.exec(req.url ?? '')?.[1];
  if (id) lookups.push(id);
  const proven = id !== undefined && proof.verifyRelayProof(req.headers['x-timon-relay-proof'], DAEMON_TOKEN, decodeURIComponent(id));
  res.writeHead(id !== undefined && !proven ? 403 : 404);
  res.end();
});
daemon.on('upgrade', (req, socket) => {
  seen.push(req.headers);
  if (req.headers.cookie === 'timon_session=shell-open') {
    // A shell that prints its prompt at once: the prompt rides with the 101.
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n$ ');
    socket.on('data', (d) => socket.write(`echo:${d.toString('utf8')}`));
    socket.on('end', () => socket.end());
    return;
  }
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});
const front = http.createServer();
let frontPort = 0;
let proxy: typeof import('./ui/terminal-ws-proxy');

before(async () => {
  await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  proof = await import(new URL('../../../orchestrator/src/machines/relay-proof.ts', import.meta.url).href) as DaemonProof;
  // `paths.ts` reads the daemon's address and the home at import: set them
  // first. The proof's key comes from this home, never from an inherited one.
  home = mkdtempSync(join(tmpdir(), 'timon-terminal-ws-proxy-'));
  writeFileSync(join(home, 'daemon-token'), `${DAEMON_TOKEN}\n`);
  process.env.TIMON_HOME = home;
  delete process.env.TIMON_DAEMON_TOKEN;
  process.env.ORCHESTRATOR_URL = `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`;
  proxy = await import('./ui/terminal-ws-proxy.js');
  front.on('upgrade', (req, socket, head) => {
    const id = proxy.matchTerminalWsPath(req.url);
    if (id) void proxy.handleTerminalUpgrade(id, req, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  frontPort = (front.address() as AddressInfo).port;
});
after(() => {
  front.close();
  daemon.close();
  rmSync(home, { recursive: true, force: true });
});

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('only a UUID session path is proxied', () => {
  assert.equal(proxy.matchTerminalWsPath(`/api/ui/terminal/web/sessions/${ID}/ws`), ID);
  assert.equal(proxy.matchTerminalWsPath('/api/ui/terminal/web/sessions/../../admin/ws'), null);
  assert.equal(proxy.matchTerminalWsPath(`/api/ui/terminal/web/sessions/${ID}/ws/extra`), null);
});

test('only the session cookie leaves the jar', () => {
  assert.equal(proxy.sessionCookieOnly('a=1; timon_session=abc; b=2'), 'timon_session=abc');
  assert.equal(proxy.sessionCookieOnly('a=1'), undefined);
  assert.equal(proxy.sessionCookieOnly(undefined), undefined);
});

function handshake(lines: string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    const socket = net.connect(frontPort, '127.0.0.1', () => {
      socket.write([`GET /api/ui/terminal/web/sessions/${ID}/ws HTTP/1.1`, ...lines, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', '', ''].join('\r\n'));
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
  });
}

test('behind tailscale serve (Docker app), the tailnet host is kept, not the loopback one', async () => {
  // tailscale serve → http://127.0.0.1:3100: Host may be the loopback target,
  // X-Forwarded-Host carries the name the phone used.
  await handshake(['Host: 127.0.0.1:3100', 'X-Forwarded-Host: pc.tailnet.ts.net', 'X-Forwarded-Proto: https', 'Origin: https://pc.tailnet.ts.net', 'Cookie: timon_session=tok']);
  const headers = seen.at(-1)!;
  assert.equal(headers['x-forwarded-host'], 'pc.tailnet.ts.net');
  assert.equal(headers.origin, 'https://pc.tailnet.ts.net');
  assert.equal(headers.host, new URL(process.env.ORCHESTRATOR_URL!).host);
});

test('the handshake reaches the daemon with the reached host, and its refusal comes back', async () => {
  const status = await new Promise<string>((resolve) => {
    const socket = net.connect(frontPort, '127.0.0.1', () => {
      socket.write([
        `GET /api/ui/terminal/web/sessions/${ID}/ws HTTP/1.1`,
        'Host: timon.example:3101',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Origin: https://timon.example:3101',
        'Cookie: other=x; timon_session=tok',
        '', '',
      ].join('\r\n'));
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
  });
  assert.match(status, /^HTTP\/1\.1 403/);
  const headers = seen.at(-1)!;
  assert.equal(headers.cookie, 'timon_session=tok');
  assert.equal(headers['x-forwarded-host'], 'timon.example:3101');
  assert.equal(headers.origin, 'https://timon.example:3101');
});

test('the upstream handshake carries the credential it is given, never the jar', () => {
  const req = { headers: { cookie: 'timon_session=tok; other=x', origin: 'https://app.test', 'sec-websocket-key': 'k' } } as unknown as import('node:http').IncomingMessage;
  const remote = proxy.upstreamHeaders(req, 'vps.example', { authorization: 'Bearer device', origin: 'https://vps.example', 'x-forwarded-host': 'vps.example' });
  assert.equal(remote.cookie, undefined);
  assert.equal(remote.authorization, 'Bearer device');
  assert.equal(remote.host, 'vps.example');
  // The remote daemon's same-origin check sees the machine's own origin and
  // host, consistent with what its TLS proxy forwards — not this app's.
  assert.equal(remote.origin, 'https://vps.example');
  assert.equal(remote['x-forwarded-host'], 'vps.example');
  const local = proxy.upstreamHeaders(req, '127.0.0.1:3001', { cookie: 'timon_session=tok' });
  assert.equal(local.cookie, 'timon_session=tok');
  assert.equal(local.authorization, undefined);
});

const MACHINE_HANDSHAKE = ['Host: timon.example:3101', 'Origin: https://timon.example:3101', 'Cookie: timon_machine=vps; timon_session=tok'];

async function withDaemonTokenFile<T>(content: string, run: () => Promise<T>): Promise<T> {
  const file = join(home, 'daemon-token');
  writeFileSync(file, content);
  try {
    return await run();
  } finally {
    writeFileSync(file, `${DAEMON_TOKEN}\n`);
  }
}

test('a machine cookie the local daemon does not resolve is refused, never served by the local daemon', async () => {
  const before = seen.length;
  // The fake daemon answers 404 to the credential lookup: not a machine of this person.
  const status = await handshake(MACHINE_HANDSHAKE);
  assert.match(status, /^HTTP\/1\.1 404/);
  assert.equal(seen.length, before);
});

test('without the daemon token no proof can be made: refused, the local daemon is asked nothing', async () => {
  const before = seen.length;
  const asked = lookups.length;
  const status = await withDaemonTokenFile('', () => handshake(MACHINE_HANDSHAKE));
  assert.match(status, /^HTTP\/1\.1 502/);
  assert.equal(lookups.length, asked);
  assert.equal(seen.length, before);
});

test('a proof the daemon does not recognise is refused, never served by the local daemon', async () => {
  const before = seen.length;
  const asked = lookups.length;
  const status = await withDaemonTokenFile('token-of-another-install', () => handshake(MACHINE_HANDSHAKE));
  assert.match(status, /^HTTP\/1\.1 502/);
  assert.equal(lookups.length, asked + 1);
  assert.equal(seen.length, before);
});

test('a machine cookie without a local session is refused before anything is asked', async () => {
  const before = seen.length;
  const asked = lookups.length;
  const status = await handshake(['Host: timon.example:3101', 'Origin: https://timon.example:3101', 'Cookie: timon_machine=vps']);
  assert.match(status, /^HTTP\/1\.1 401/);
  assert.equal(lookups.length, asked);
  assert.equal(seen.length, before);
});

// ---- X-Timon-Machine: a window pinned to one machine ---------------------

test('X-Timon-Machine wins over the cookie: its id is the one looked up, and refused when it is not this person\'s', async () => {
  const before = seen.length;
  const asked = lookups.length;
  const status = await handshake(['Host: timon.example:3101', 'Origin: https://timon.example:3101', 'X-Timon-Machine: bobs-machine', 'Cookie: timon_machine=local; timon_session=tok']);
  assert.match(status, /^HTTP\/1\.1 404/);
  assert.deepEqual(lookups.slice(asked), ['bobs-machine']);
  assert.equal(seen.length, before);
});

test('X-Timon-Machine without a local session is refused before anything is asked', async () => {
  const before = seen.length;
  const asked = lookups.length;
  const status = await handshake(['Host: timon.example:3101', 'Origin: https://timon.example:3101', 'X-Timon-Machine: vps']);
  assert.match(status, /^HTTP\/1\.1 401/);
  assert.equal(lookups.length, asked);
  assert.equal(seen.length, before);
});

test('a malformed X-Timon-Machine is refused, never served from the cookie or locally', async () => {
  const before = seen.length;
  const asked = lookups.length;
  const status = await handshake(['Host: timon.example:3101', 'Origin: https://timon.example:3101', 'X-Timon-Machine: ../vps', 'Cookie: timon_session=tok']);
  assert.match(status, /^HTTP\/1\.1 404/);
  assert.equal(lookups.length, asked);
  assert.equal(seen.length, before);
});

test('X-Timon-Machine: local overrides a remote cookie, and the header never travels upstream', async () => {
  const asked = lookups.length;
  await handshake(['Host: timon.example:3101', 'Origin: https://timon.example:3101', 'X-Timon-Machine: local', 'Cookie: timon_machine=vps; timon_session=tok']);
  assert.equal(lookups.length, asked);
  const headers = seen.at(-1)!;
  assert.equal(headers.cookie, 'timon_session=tok');
  assert.equal(headers['x-timon-machine'], undefined);
});

test('what the shell sends with its 101 reaches the browser, not the shell', async () => {
  const got = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(frontPort, '127.0.0.1', () => {
      socket.write([`GET /api/ui/terminal/web/sessions/${ID}/ws HTTP/1.1`, 'Host: timon.example:3101', 'Origin: https://timon.example:3101', 'Cookie: timon_session=shell-open', 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', '', ''].join('\r\n'));
    });
    let data = '';
    let sent = false;
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (!sent && data.includes('\r\n\r\n')) { sent = true; socket.write('ls'); }
      if (data.endsWith('echo:ls')) { socket.end(); resolve(data); }
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error(`timeout: ${JSON.stringify(data)}`)); });
  });
  assert.match(got, /^HTTP\/1\.1 101 /);
  assert.equal(got.slice(got.indexOf('\r\n\r\n') + 4), '$ echo:ls');
});
