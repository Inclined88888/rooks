/**
 * Who may run a workflow `script` node (TODO #685).
 *
 * A script node runs a program on the host under the daemon's OS account —
 * `~/.rooks/daemon-token` is readable from there. It is held to the rule of
 * a trigger's `script` action (`triggers/script-run.ts`, SECURITY.md §9.2):
 *
 *  - the run acts as the workflow's OWNER, whose account must hold
 *    `scripts:run`, checked at publish and again at every run (a revoked
 *    grant stops the next run, not the next publish);
 *  - an agent never writes, publishes or runs script content a person has not
 *    put there, whatever its token holds (a developer-owner mission carries
 *    every permission): it proposes the change (`workflow_propose`) and a
 *    person accepts it.
 */
import { z } from 'zod';
import { dbApi } from '../../db.js';
import { userAllows } from '../../users/permissions.js';

export const SCRIPT_NODE_PERMISSION = 'scripts:run';

/** What an agent reads when it adds or changes a script node. */
export const SCRIPT_NODE_AGENT_REFUSAL = 'an agent cannot add, change, publish or run an unpublished script node: '
  + 'propose the change with workflow_propose for the user to accept, or ask the user';

type NodeLike = { id: string; type: string; config: Record<string, unknown> };

/**
 * Why `ownerUserId` may not run a script node, or `null`. No account on the
 * install (open setup) and no owner, or the daemon-token as owner, both mean
 * the operator's own workflow. Anything else must be an active account holding
 * `scripts:run`: a plugin or a system token is refused, failing closed.
 */
export function scriptNodeDenied(ownerUserId: string | null): string | null {
  if (dbApi.countUsers() === 0 || ownerUserId === null || ownerUserId === 'daemon-token') return null;
  if (ownerUserId.startsWith('plugin:')) return 'not permitted: a plugin cannot own a workflow that runs a script';
  const owner = dbApi.getUserById(ownerUserId);
  if (!owner || owner.status !== 'active') return 'not permitted: the workflow owner is not an active account';
  if (!userAllows(owner, dbApi.listPermissionsForUser(owner.id), SCRIPT_NODE_PERMISSION)) {
    return `not permitted: a script node needs ${SCRIPT_NODE_PERMISSION} on the workflow owner's account`;
  }
  return null;
}

/**
 * Publish refuses what the run would refuse, naming the node (a `ZodError`
 * so `describeWorkflowError` hands the builder its per-node issues).
 */
export function assertScriptNodesAllowed(nodes: ReadonlyArray<NodeLike>, ownerUserId: string | null): void {
  const scripts = nodes.filter((node) => node.type === 'script');
  if (!scripts.length) return;
  const reason = scriptNodeDenied(ownerUserId);
  if (!reason) return;
  throw new z.ZodError(scripts.map((node): z.core.$ZodIssue => ({ code: 'custom', message: `${reason} (${node.id})`, path: ['nodes', node.id], input: node.config })));
}

/** Key order aside: a stored config and the same one sent back by the builder. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v));
}

/**
 * Ids of the script nodes of `next` that `previous` does not hold as they are
 * (added, or config changed). A script node kept untouched is not the
 * caller's doing: an agent may still edit the rest of a workflow a person
 * armed with a script.
 */
export function changedScriptNodes(next: ReadonlyArray<NodeLike>, previous: ReadonlyArray<NodeLike> | null | undefined): string[] {
  const before = new Map((previous ?? []).filter((node) => node.type === 'script').map((node) => [node.id, canonical(node.config)]));
  return next.filter((node) => node.type === 'script' && before.get(node.id) !== canonical(node.config)).map((node) => node.id);
}
