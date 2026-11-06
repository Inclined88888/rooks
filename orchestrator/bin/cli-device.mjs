/**
 * `timon device pair|list|rename|revoke` — paired devices from a terminal,
 * for a server that has no interface open to click "Authorize a new device".
 *
 * The routes decide who may act (`users/devices-http.ts`): the daemon-token
 * issues the code for the active superadmin, a mission's api-token and a
 * device token are refused. Nothing here widens that.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The address another machine pairs against: a `tailscale serve` handler at
 * the root of a tailnet vhost that forwards to THIS daemon on the loopback.
 * Same rule as `pairingAddress` in `app/src/lib/webui-access.ts` (the two
 * packages are independent); the web interface's address would answer
 * "code refused".
 */
export function pairingAddress(report) {
  const port = report?.security?.daemon?.port;
  const serve = report?.tailscale?.serve;
  if (typeof port !== 'number' || !Array.isArray(serve)) return null;
  for (const handler of serve) {
    if (typeof handler?.host !== 'string' || typeof handler.target !== 'string' || handler.host.includes('/')) continue;
    let target;
    let vhost;
    try {
      target = new URL(handler.target);
      vhost = new URL(`https://${handler.host}`);
    } catch {
      continue;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;
    if (!LOOPBACK_HOSTS.has(target.hostname) || target.port !== String(port)) continue;
    return vhost.origin;
  }
  return null;
}

function clock(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toLocaleTimeString() : '—';
}

function day(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—';
}

/** The code card of the settings screen, as text. */
export function pairingText({ code, expiresAt, email, address, daemonPort, platform = process.platform }) {
  const lines = [
    `Pairing code${email ? ` for ${email}` : ''}: ${code}`,
    `Valid until ${clock(expiresAt)} (5 minutes), single use. Treat it like a password.`,
    '',
    'On the other computer: Settings → Plugins → Machines → Add a machine.',
  ];
  if (address) {
    lines.push(`Machine address: ${address}`);
  } else {
    // The daemon-token only reaches the local listener, so this host IS the
    // daemon's: its OS decides how `tailscale serve` gets the right to run.
    const elevate = platform === 'linux' ? 'sudo ' : '';
    lines.push(
      'Machine address: this daemon is not published on your tailnet yet. Publish it over HTTPS'
        + (platform === 'win32' ? ' (in a terminal opened as administrator)' : '') + ', then use that address:',
      `  ${elevate}tailscale serve --bg --https=8443 http://127.0.0.1:${daemonPort ?? '<daemon port>'}`,
      '  tailscale serve status',
    );
  }
  return lines.join('\n') + '\n';
}

export function deviceListText(devices) {
  if (!devices.length) return 'No paired device.\n';
  const rows = devices.map((d) => [
    d.id, d.name, d.status, `paired ${day(d.created_at)}`, `last seen ${day(d.last_seen_at)}`, d.last_ip ?? '—',
  ].join('  '));
  return rows.join('\n') + '\n';
}

const USAGE = 'usage: timon device pair [--user <email-or-id>] [--json]\n'
  + '       timon device list [--json]\n'
  + '       timon device rename <id> <name>\n'
  + '       timon device revoke <id>\n';

/**
 * @param {string[]} argv
 * @param {{ http: (method: string, path: string, body?: unknown) => Promise<any>,
 *           httpRaw: (method: string, path: string, body?: unknown) => Promise<{ ok: boolean, status: number, body: any }>,
 *           findUser: (spec: string) => Promise<{ id: string, email: string }>,
 *           takeFlag: (argv: string[], name: string) => string | undefined,
 *           out: (text: string) => void, err: (text: string) => void, exit: (code: number) => never }} io
 */
export async function cmdDevice(argv, io) {
  const [sub, ...rest] = argv;
  const json = rest.includes('--json');
  const args = rest.filter((a) => a !== '--json');
  switch (sub) {
    case 'pair': {
      const asked = args.some((a) => a === '--user' || a.startsWith('--user='));
      const spec = io.takeFlag(args, 'user');
      // A bare `--user` must not fall back to a code for the caller's own account.
      if (args.length || (asked && !spec)) {
        io.err(USAGE);
        return io.exit(64);
      }
      const user = spec ? await io.findUser(spec) : null;
      const issued = await io.http('POST', '/api/devices/pairing-codes', user ? { user_id: user.id } : {});
      // The address is a convenience: a daemon whose report cannot be read
      // still issues a valid code, and the hint below says how to get one.
      const access = await io.httpRaw('GET', '/api/webui-access');
      const report = access.ok ? access.body : null;
      const address = pairingAddress(report);
      if (json) {
        io.out(JSON.stringify({ ...issued, address }, null, 2) + '\n');
        return;
      }
      io.out(pairingText({
        code: issued.code,
        expiresAt: issued.expires_at,
        email: user?.email ?? null,
        address,
        daemonPort: report?.security?.daemon?.port,
      }));
      return;
    }
    case 'list':
    case undefined: {
      const data = await io.http('GET', '/api/devices');
      const devices = Array.isArray(data.devices) ? data.devices : [];
      io.out(json ? JSON.stringify(devices, null, 2) + '\n' : deviceListText(devices));
      return;
    }
    case 'rename': {
      const [id, ...words] = args;
      const name = words.join(' ').trim();
      if (!id || !name) {
        io.err(USAGE);
        return io.exit(64);
      }
      const data = await io.http('PATCH', `/api/devices/${encodeURIComponent(id)}`, { name });
      io.out(`renamed: ${data.device.id}  ${data.device.name}\n`);
      return;
    }
    case 'revoke': {
      const [id] = args;
      if (!id || args.length > 1) {
        io.err(USAGE);
        return io.exit(64);
      }
      const data = await io.http('DELETE', `/api/devices/${encodeURIComponent(id)}`);
      io.out(`revoked: ${data.device.id}  ${data.device.name}\n`);
      return;
    }
    default:
      io.err(USAGE);
      return io.exit(64);
  }
}
