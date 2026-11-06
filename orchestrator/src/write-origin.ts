/**
 * Who is writing right now: a user, an agent, a plugin, or the daemon itself.
 *
 * Bus events carry ids and snapshots, not their author, and their shape is
 * frozen for the listeners that already read them. The origin therefore rides
 * beside the write instead: the writer runs inside `withWriteOrigin`, and a
 * listener that reads `currentWriteOrigin()` SYNCHRONOUSLY in the bus callback
 * gets the writer of the event it handles — `bus.publish` is a synchronous
 * emit, so it runs inside the writer's store.
 *
 * Used by the TO DO notebook (`todo-origin.ts`, where a connector drops the
 * echo of its own writes: a ticket closed on GitHub closes the idea here, and
 * the `todo_done` that follows must not close the ticket again) and by the
 * agent events (`agent_created`, `agent_updated`, `agent_deleted`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { dbApi } from './db.js';
import { PLUGIN_OWNER_PREFIX } from './users/api-tokens.js';
import type { WriteOrigin } from './plugins/contract/origin.js';
export type { WriteOrigin } from './plugins/contract/origin.js';

const SYSTEM: WriteOrigin = Object.freeze({ kind: 'system', id: null });

const store = new AsyncLocalStorage<WriteOrigin>();

export function withWriteOrigin<T>(origin: WriteOrigin, fn: () => T): T {
  return store.run(Object.freeze({ ...origin }), fn);
}

/** Outside any write that named itself (the chain closing an idea, a bundled
 *  module), the daemon. */
export function currentWriteOrigin(): WriteOrigin {
  return store.getStore() ?? SYSTEM;
}

/**
 * The origin of an HTTP write. Only what the auth middleware established
 * counts: a mission token names its agent, a plugin token its plugin. The
 * `X-TIMON-Agent` header is believed only behind the daemon token, whose
 * holders (CLI, MCP shim) are trusted to name the agent they speak for.
 */
export function writeOriginFromRequest(req: Request): WriteOrigin {
  const auth = req.auth;
  if (auth?.missionId) {
    const agent = dbApi.getMission(auth.missionId)?.agent_name;
    return { kind: 'agent', id: agent ?? auth.missionId };
  }
  if (auth?.kind === 'daemon-token') {
    const agent = req.header('X-TIMON-Agent');
    if (agent) return { kind: 'agent', id: agent };
  }
  if (auth?.user) return { kind: 'user', id: auth.user.id };
  if (auth?.actorId?.startsWith(PLUGIN_OWNER_PREFIX)) {
    return { kind: 'plugin', id: auth.actorId.slice(PLUGIN_OWNER_PREFIX.length) };
  }
  return SYSTEM;
}

/**
 * Express middleware naming the writer of every mutating request below the
 * path it is mounted on, for the listeners of the events that write causes.
 * A read passes through untouched.
 */
export function recordWriteOrigin(req: Request, _res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') { next(); return; }
  withWriteOrigin(writeOriginFromRequest(req), next);
}
