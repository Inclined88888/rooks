/**
 * Id of a backend INSTANCE: one subscription account of a backend
 * (`claude@k3f9a2b1c0`). Wherever a backend id is stored (agent config, task
 * override, project role, series rule, mission row), an instance id fits:
 * that is how the account travels without a field of its own (TODO #52).
 *
 * `@` cannot appear in a backend id (`LOCAL_BACKEND_ID_RE`, product profiles),
 * so a bare id and an instance id never collide.
 */
export const ACCOUNT_SEPARATOR = '@';

/** Account ids are minted by the daemon (`backends/accounts.ts`). */
export const ACCOUNT_ID_RE = /^[a-z0-9]{6,32}$/;

export function accountInstanceId(backend: string, accountId: string): string {
  return `${backend}${ACCOUNT_SEPARATOR}${accountId}`;
}

/** `{ backend, accountId }`; `accountId` null for a bare backend id. */
export function splitBackendInstance(id: string): { backend: string; accountId: string | null } {
  const at = id.indexOf(ACCOUNT_SEPARATOR);
  if (at <= 0) return { backend: id, accountId: null };
  return { backend: id.slice(0, at), accountId: id.slice(at + 1) || null };
}

export function baseBackendId(id: string): string;
export function baseBackendId(id: string | null | undefined): string | null;
export function baseBackendId(id: string | null | undefined): string | null {
  return id ? splitBackendInstance(id).backend : null;
}

export function isAccountInstanceId(id: string | null | undefined): boolean {
  return !!id && splitBackendInstance(id).accountId !== null;
}

/**
 * The account a spawn runs on, carried beside the profile's runtime. Kept out
 * of the plugin SDK's `ProfileRuntime` on purpose: only the product's own
 * dialects honour it, a third-party one would ignore it and run on the host's
 * sign-in.
 */
export type RuntimeAccount = { id: string; name: string; configDir: string };

export function runtimeAccount(runtime: object): RuntimeAccount | undefined {
  return (runtime as { account?: RuntimeAccount }).account;
}
