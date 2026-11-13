/** Account policy for agents; commercial labels and local developer flags are not authority. */
import { licenseState } from '../license/runtime.js';
import { isFormCardTool } from '../ask-mcp.js';
import { normalizePermission, permissionDenies } from './permissions.js';

export function isDeveloperAccount(user: { is_superadmin: boolean } | null | undefined): boolean {
  const license = licenseState();
  return !!user?.is_superadmin && license.status === 'valid' && license.planId === 'internal'
    && license.expiresAt !== null && Date.parse(license.expiresAt) > Date.now();
}

/**
 * Whether a developer account's tool use is allowed without a card. One rule
 * for both ways a permission request reaches the daemon (the MCP shim's
 * `POST /api/permissions/request` and an ACP session's own gate). A form card
 * is the exception: its answer is the user's, so it always opens its card.
 */
export function developerAutoAllows(
  user: { is_superadmin: boolean } | null | undefined, toolName: string,
): boolean {
  return isDeveloperAccount(user) && !isFormCardTool(toolName);
}

/** Communication is opt-out; explicit action/domain denials still win for ordinary users. */
export function agentCommunicationAllowed(
  user: { is_superadmin: boolean }, grants: readonly string[], action: string,
): boolean {
  if (isDeveloperAccount(user)) return true;
  return !grants.some((raw) => {
    const p = normalizePermission(raw);
    return p.startsWith('-') && ['agents:communicate', action].some((a) => permissionDenies(p.slice(1), a));
  });
}
