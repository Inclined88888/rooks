/**
 * The server side of `acting-account.ts`: asking a remote machine who this
 * computer's device acts as there, and folding the answer into
 * `/api/ui/auth/me`. Server only (it holds the device token's relay).
 */
import { parseActingUser, parseCan, parseScheme, type ActingAccount } from './acting-account';
import { fetchActingAccount, type RemoteTarget, type Target } from './target';

/** One read of the acting account; a test seam for the two callers. */
export type ActingRead = (target: RemoteTarget) => Promise<ActingAccount>;

/** Never throws: a machine that cannot say gives `user: null`, never a guess. */
export const readActingAccount: ActingRead = async (target) => {
  const unknown: ActingAccount = { machine: target.id, user: null, can: null };
  try {
    const res = await fetchActingAccount(target, AbortSignal.timeout(target.timeoutMs));
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return unknown;
    }
    const body = await res.json() as { user?: unknown; can?: unknown; prefs?: { scheme?: unknown } | null } | null;
    const user = parseActingUser(body?.user);
    // The mode that machine keeps for the device's account: read with the
    // account, so a window on it paints that machine's choice, not this one's.
    const scheme = user ? parseScheme(body?.prefs?.scheme) : null;
    return { machine: target.id, user, can: parseCan(body?.can), ...(scheme ? { scheme } : {}) };
  } catch {
    return unknown;
  }
};

/**
 * `/api/ui/auth/me`: the local daemon's answer, plus `acting` when a remote
 * machine is active. The local answer is what proves the session: without an
 * account in it (anonymous, expired, a failed read), nothing is asked of the
 * remote and nothing is added. A machine the relay cannot reach (`unavailable`
 * target) is named with no account.
 */
export async function withActingAccount(
  local: globalThis.Response,
  target: Target,
  read: ActingRead = readActingAccount,
): Promise<globalThis.Response> {
  if (target.kind === 'local' || !local.ok) return local;
  const text = await local.text();
  const rebuilt = (body: string) => new Response(body, { status: local.status, statusText: local.statusText, headers: local.headers });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rebuilt(text);
  }
  const user = body && typeof body === 'object' ? (body as { user?: { id?: unknown } | null }).user : null;
  if (typeof user?.id !== 'string' || !user.id) return rebuilt(text);
  const acting: ActingAccount = target.kind === 'remote'
    ? await read(target)
    : { machine: target.id, user: null, can: null };
  return rebuilt(JSON.stringify({ ...(body as object), acting }));
}
