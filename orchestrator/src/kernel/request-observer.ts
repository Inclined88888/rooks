/**
 * How HTTP requests ended, for a module that must observe every route without
 * owning one (product analytics: `@timon/telemetry`).
 *
 * A module router only sees the requests that reach it, in mount order, so a
 * middleware of its own would miss every route mounted before it. This hook is
 * registered once at boot, right after authentication, and reports to its
 * listeners when the response is finished. It carries no body, no URL and no
 * parameter value: only the route TEMPLATE Express matched (`/api/agents/:name`),
 * the status, and the `error` code a JSON error body named.
 *
 * `errorText` and `errorSystemCode` are the raw failure (an error body's text, a
 * thrown error's message and `code`), for IN-PROCESS classification only: a
 * listener reduces them to a closed cause and must never send or store them —
 * they may hold paths, names or addresses.
 * Without a listener, it costs a function call per request.
 */
import type { Request, RequestHandler, Response } from 'express';

export type FinishedRequest = {
  method: string;
  /** `baseUrl` + matched route path, `null` when no route answered (404, static file). */
  template: string | null;
  status: number;
  /** The `error` field of a JSON error body, bounded; `null` otherwise. */
  errorCode: string | null;
  /** Raw failure text (error body, thrown message), bounded. Never leaves the process. */
  errorText: string | null;
  /** A thrown error's `code` (`ECONNREFUSED`, `SQLITE_BUSY`), when it had one. */
  errorSystemCode: string | null;
  /** The account behind the request, when a person or their device made it. */
  userId: string | null;
  /** `person`: a session or a paired device; `mission`: an agent's token; `daemon`: the CLI and MCP token. */
  actor: 'person' | 'mission' | 'daemon' | 'other';
};

export type RequestListener = (request: FinishedRequest) => void;

const listeners = new Set<RequestListener>();

/** Subscribes to finished requests; returns what unsubscribes. */
export function onRequestFinished(listener: RequestListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const ERROR_CODE = /^[a-z][a-z0-9_:.-]{0,63}$/i;
const ERROR_TEXT_MAX = 500;

/** The error a route failed with, noted by the shared error handler before it answers. */
const thrown = new WeakMap<Response, unknown>();
export function noteRequestError(res: Response, err: unknown): void {
  thrown.set(res, err);
}

function bounded(text: unknown): string | null {
  return typeof text === 'string' && text ? text.slice(0, ERROR_TEXT_MAX) : null;
}

function templateOf(req: Request): string | null {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof path !== 'string') return null;
  return `${req.baseUrl ?? ''}${path}` || '/';
}

export function createRequestObserver(): RequestHandler {
  return (req: Request, res: Response, next) => {
    if (listeners.size === 0) return next();
    let errorCode: string | null = null;
    let errorText: string | null = null;
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode >= 400 && body && typeof body === 'object') {
        const { error: code, message } = body as { error?: unknown; message?: unknown };
        if (typeof code === 'string' && ERROR_CODE.test(code)) errorCode = code;
        errorText = bounded(typeof code === 'string' ? (typeof message === 'string' ? `${code} ${message}` : code) : message);
      }
      return json(body);
    }) as Response['json'];
    res.on('finish', () => {
      const auth = req.auth;
      const err = thrown.get(res) as { message?: unknown; code?: unknown } | undefined;
      const systemCode = typeof err?.code === 'string' && ERROR_CODE.test(err.code) ? err.code : null;
      const finished: FinishedRequest = {
        method: req.method,
        template: templateOf(req),
        status: res.statusCode,
        errorCode,
        errorText: bounded(err?.message) ?? errorText,
        errorSystemCode: systemCode,
        userId: auth?.user?.id ?? null,
        actor: auth?.kind === 'session' || auth?.kind === 'device' ? 'person'
          : auth?.kind === 'api-token' && auth.missionId ? 'mission'
            : auth?.kind === 'daemon-token' ? 'daemon' : 'other',
      };
      for (const listener of listeners) {
        try { listener(finished); } catch { /* an observer never breaks a response */ }
      }
    });
    next();
  };
}
