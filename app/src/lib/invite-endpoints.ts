/**
 * Where the invitation page sends its two calls.
 *
 * Invitations belong to the plugin that serves the accounts (the multi-user
 * plugin), which answers on two public routes of its own:
 *   GET  `invite/<token>` → `{ email, name }`, 404 when the invitation is unknown or spent;
 *   POST `invite/accept` with `{ token, name, password }` → opens the session.
 * The daemon names that plugin (`GET /api/auth/account-provider`); the page never
 * reads a plugin id from the link, so a crafted link cannot send a password to
 * another installed plugin. The core has no invitation of its own: with no
 * provider there is nothing to call, and the page reads it as an unknown link.
 */

export type InviteEndpoints = {
  lookup(token: string): string;
  accept: string;
};

export function inviteEndpoints(provider: string): InviteEndpoints {
  const base = `/api/ui/plugins/${encodeURIComponent(provider)}`;
  return {
    lookup: (token) => `${base}/invite/${encodeURIComponent(token)}`,
    accept: `${base}/invite/accept`,
  };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** `null` when no plugin serves the accounts, or when the daemon cannot say. */
export async function resolveInviteEndpoints(fetcher: Fetch = fetch): Promise<InviteEndpoints | null> {
  try {
    const response = await fetcher('/api/ui/auth/account-provider', { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json() as { provider?: unknown };
    return typeof payload.provider === 'string' && payload.provider ? inviteEndpoints(payload.provider) : null;
  } catch {
    return null;
  }
}
