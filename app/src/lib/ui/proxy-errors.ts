/**
 * The daemon answers a request that no mounted route serves with Express's HTML
 * page ("Cannot GET /api/…"). A module turned off in the settings unmounts its
 * routes, so this is an ordinary state, not a crash — but the browser then
 * choked on `<!DOCTYPE` while parsing JSON and showed "Unexpected token '<'".
 */
export function htmlFailureAsJson(status: number, contentType: string | null, ok: boolean): { status: number; body: string } | null {
  if (ok || !/text\/html/i.test(contentType ?? '')) return null;
  // Same `{ error, code, params }` shape as the daemon's errors, so the webview translates these too.
  const body = status === 404
    ? { error: 'This feature is not available on this install: the module that serves it is turned off or not installed.', code: 'module_unavailable' }
    : { error: `The daemon answered HTTP ${status} with a web page instead of data.`, code: 'daemon_html_response', params: { status } };
  return { status, body: JSON.stringify(body) };
}
