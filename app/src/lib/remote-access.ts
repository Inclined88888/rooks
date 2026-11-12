import type { WebUiAccessReport } from './webui-access';

/** The daemon's listener, as `/api/ui/webui-access` reports it. */
export type AppListener = WebUiAccessReport['app'];

/** The browser origin may belong to a reverse proxy or a remote device.
 * Only a daemon-managed listener gives us a known local forwarding target.
 * External hosting stays unknown, even when a browser URL has a port.
 *
 * The report is JSON nobody validated: every field is checked again here,
 * since it ends up in a command someone will paste into a shell.
 */
export function remoteAccessCommands(app: Partial<AppListener> | null | undefined): { up: string; serve: string | null } {
  const result: { up: string; serve: string | null } = { up: 'tailscale up', serve: null };
  if (!app || typeof app !== 'object') return result;
  const listener: { servedByDaemon?: unknown; host?: unknown; port?: unknown } = app;
  if (listener.servedByDaemon !== true || typeof listener.port !== 'number'
    || !Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) return result;
  // Wildcard binds accept loopback too; never interpolate an arbitrary host
  // into a command someone will paste into a shell.
  const host = listener.host === '::' || listener.host === '::1' ? '[::1]'
    : listener.host === '127.0.0.1' || listener.host === '0.0.0.0' ? '127.0.0.1' : null;
  if (host) result.serve = `tailscale serve --bg --https=443 http://${host}:${listener.port}`;
  return result;
}
