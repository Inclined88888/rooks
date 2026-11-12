/**
 * Subscription accounts of a backend (TODO #52): the list, and signing one in
 * from the browser (volet 3). Mirrors `plugins-bundled/backends/account-routes.ts`
 * and `backends/account-login.ts` on the daemon.
 *
 * The sign-in flow is bound to this browser session on the daemon side: the
 * URL and the device code come back through a poll of this session's own
 * request, never through the shared event stream.
 */

import type { AccountState, BackendName } from '@/lib/backends';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';

export type BackendAccount = {
  id: string;
  instance: string;
  backend: BackendName;
  name: string;
  ownerUserId: string | null;
  mine: boolean;
  state: AccountState;
  /** Signed in through Rooks. */
  connected: boolean;
  /** Who it is signed in as: present for its owner and the superadmin. */
  identity?: string | null;
  grantedTo?: string[];
};

export type LoginPrompt =
  | { kind: 'paste-code'; url: string }
  | { kind: 'device-code'; url: string; code: string };

export type LoginState = 'starting' | 'waiting' | 'verifying' | 'connected' | 'failed';

export type LoginFailure =
  | 'expired' | 'cancelled' | 'code_rejected' | 'duplicate' | 'mismatch'
  | 'not_signed_in' | 'cli_failed' | 'cli_missing' | 'unsupported';

export type AccountLogin = {
  accountId: string;
  backend: BackendName;
  state: LoginState;
  prompt: LoginPrompt | null;
  failure: LoginFailure | null;
  identity: string | null;
  codeSent: boolean;
  startedAt: number;
  expiresAt: number;
};

export type AccountsPage = { accounts: BackendAccount[]; backends: BackendName[] };

const BASE = '/api/ui/backends/accounts';

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
  return body.reason ?? apiErrorMessage(body, t('backendAccounts.errorGeneric'));
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

export async function fetchAccounts(): Promise<AccountsPage> {
  const page = await send<Partial<AccountsPage>>('GET', '');
  return { accounts: page.accounts ?? [], backends: page.backends ?? [] };
}

export async function createAccount(input: { backend: BackendName; name: string; ownerUserId?: string | null }): Promise<BackendAccount> {
  return (await send<{ account: BackendAccount }>('POST', '', input)).account;
}

export async function renameAccount(id: string, name: string): Promise<BackendAccount> {
  return (await send<{ account: BackendAccount }>('PATCH', `/${encodeURIComponent(id)}`, { name })).account;
}

/** The whole list of users who may use the account: it replaces the previous one. */
export async function setAccountGrants(id: string, userIds: string[]): Promise<BackendAccount> {
  return (await send<{ account: BackendAccount }>('PUT', `/${encodeURIComponent(id)}/grants`, { userIds })).account;
}

export async function deleteAccount(id: string): Promise<void> {
  await send('DELETE', `/${encodeURIComponent(id)}`);
}

export async function startLogin(id: string): Promise<AccountLogin> {
  return (await send<{ login: AccountLogin }>('POST', `/${encodeURIComponent(id)}/login`, {})).login;
}

/** The flow, or null once the daemon no longer has it for this session. */
export async function readLogin(id: string): Promise<AccountLogin | null> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/login`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await readError(res));
  return ((await res.json()) as { login: AccountLogin }).login;
}

export async function sendLoginCode(id: string, code: string): Promise<AccountLogin> {
  return (await send<{ login: AccountLogin }>('POST', `/${encodeURIComponent(id)}/login/code`, { code })).login;
}

export async function cancelLogin(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/login`, { method: 'DELETE', cache: 'no-store' });
  if (!res.ok && res.status !== 404) throw new Error(await readError(res));
}

export function isLoginOver(login: AccountLogin | null): boolean {
  return !login || login.state === 'connected' || login.state === 'failed';
}

/** The pasted text, as the daemon takes it: one line, no surrounding blanks. */
export function cleanPastedCode(text: string): string {
  return text.replace(/[\r\n]+/g, '').trim();
}

/** What a failed flow tells the person, and what to do next. */
export function loginFailureText(login: AccountLogin): string {
  const failure = login.failure ?? 'cli_failed';
  return failure === 'mismatch'
    ? t('backendAccounts.failure.mismatch', { identity: login.identity ?? '?' })
    : t(`backendAccounts.failure.${failure}`);
}

export type AccountStatus = 'connected' | 'notConnected' | 'reauth' | 'cooldown';

/** One word for the row: what the account needs, if anything. */
export function accountStatus(account: BackendAccount): AccountStatus {
  if (account.state === 'reauth') return 'reauth';
  if (account.state === 'cooldown') return 'cooldown';
  return account.connected ? 'connected' : 'notConnected';
}
