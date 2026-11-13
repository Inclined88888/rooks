/**
 * "Show in system explorer" for the Files widget. Where the file manager opens
 * depends on where a desktop session exists:
 *
 *  - the daemon itself, when it has one;
 *  - the Electron client, from the user's own session, when it does not. The
 *    desktop shell makes the request itself with the user's session and shows
 *    the path the daemon answers — this code hands it an agent and a relative
 *    path, never a filesystem path, so a compromised page cannot make the
 *    shell show or open an arbitrary one;
 *  - a plain browser against a daemon with no session is told so; it is never
 *    shown a success.
 */
export type RevealOutcome =
  | { status: 'opened' }
  | { status: 'no-desktop' }
  | { status: 'failed'; message: string | null };

type RevealBridge = {
  revealPath?: (request: { agentId: string; path: string }) => Promise<unknown>;
} | null;

type RevealReply = {
  kind?: string;
  error?: unknown;
  code?: unknown;
};

function outcomeOf(value: unknown): RevealOutcome {
  const v = (value && typeof value === 'object' ? value : {}) as { status?: unknown; message?: unknown };
  if (v.status === 'opened') return { status: 'opened' };
  if (v.status === 'no-desktop') return { status: 'no-desktop' };
  return { status: 'failed', message: typeof v.message === 'string' ? v.message : null };
}

export async function revealOnDesktop(opts: {
  agentId: string;
  path: string;
  bridge: RevealBridge;
  fetchFn?: typeof fetch;
}): Promise<RevealOutcome> {
  const { bridge, agentId, path } = opts;
  if (typeof bridge?.revealPath === 'function') {
    try {
      return outcomeOf(await bridge.revealPath({ agentId, path }));
    } catch (err) {
      return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
  }
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  let reply: RevealReply = {};
  try {
    res = await fetchFn('/api/ui/agents/' + encodeURIComponent(agentId) + '/files/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    // A host with no desktop module answers a non-JSON 404.
    reply = await res.json().catch(() => ({})) as RevealReply;
  } catch (err) {
    return { status: 'failed', message: String(err) };
  }
  if (!res.ok) {
    if (reply.code === 'no_desktop_session') return { status: 'no-desktop' };
    return { status: 'failed', message: typeof reply.error === 'string' ? reply.error : null };
  }
  if (reply.kind === 'revealed') return { status: 'opened' };
  // Only a client hint makes the daemon answer `client`; a browser sends none.
  if (reply.kind === 'client') return { status: 'no-desktop' };
  return { status: 'failed', message: null };
}
