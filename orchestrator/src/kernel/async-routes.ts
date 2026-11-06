/**
 * Async route handlers on Express 4 (TODO #580).
 *
 * The daemon runs Express 4, whose `Layer` calls a handler inside a try/catch
 * and DROPS its return value: an `async` handler that rejects becomes an
 * unhandled rejection, and Node exits with code 1 — the service and every live
 * mission with it. The published contract types are Express 5 (`@types/express`
 * ^5), which do catch promises, so a plugin author has every reason to write
 * `router.get('/x', async …)` without a try/catch.
 *
 * Two pieces:
 *   - `catchAsyncHandlers()` teaches Express 4's `Layer` what Express 5 does
 *     natively: a rejected promise from a handler becomes `next(err)`. Patched
 *     on the prototype, so it covers every router of the process — bundled
 *     modules, third-party plugins, `.route()` chains and routes set on the
 *     app itself. Reached through a live router rather than
 *     `require('express/lib/router/layer')`: no dependency on Express's file
 *     layout, which a bundler or a future version may move.
 *   - `routeErrorHandler(owner)` is what the mount shell (`HttpService.mount`)
 *     hands a router as its `next`: an error leaving a module's router is
 *     logged under that module's name and answered with a JSON 500, without
 *     the error's message (it may carry a path, a token, a query).
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { noteRequestError } from './request-observer.js';

type Handler = (...args: unknown[]) => unknown;
interface LayerLike {
  handle: Handler;
  handle_request(req: Request, res: Response, next: NextFunction): void;
  handle_error(err: unknown, req: Request, res: Response, next: NextFunction): void;
}

const PATCHED = Symbol.for('timon.asyncRouteHandlers');

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/** `next(undefined)` would mean "carry on", not "fail": a falsy rejection still is one. */
function rejectionError(reason: unknown): unknown {
  return reason || new Error(`async route handler rejected with ${String(reason)}`);
}

function forward(result: unknown, next: NextFunction): void {
  if (isThenable(result)) result.then(undefined, (reason: unknown) => next(rejectionError(reason)));
}

/**
 * Makes a rejected promise from any route handler or error handler reach
 * `next(err)`. Idempotent; returns false when Express's internals are not the
 * shape this was written against (the daemon then keeps Express's own
 * behaviour rather than breaking every route).
 */
export function catchAsyncHandlers(): boolean {
  const probe = express.Router();
  probe.use((_req, _res, next) => next());
  const stack = (probe as unknown as { stack?: unknown[] }).stack;
  const proto = stack?.[0] ? Object.getPrototypeOf(stack[0]) as Partial<LayerLike> & { [PATCHED]?: true } : undefined;
  if (!proto || typeof proto.handle_request !== 'function' || typeof proto.handle_error !== 'function') {
    console.warn('[http] Express layer not recognised: a rejected async route handler will not be caught');
    return false;
  }
  if (proto[PATCHED]) return true;

  // Same arity rules and same try/catch as Express 4; only the promise is new.
  proto.handle_request = function handleRequest(this: LayerLike, req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try { forward(fn(req, res, next), next); } catch (err) { next(err); }
  };
  proto.handle_error = function handleError(this: LayerLike, error, req, res, next) {
    const fn = this.handle;
    if (fn.length !== 4) return next(error);
    try { forward(fn(error, req, res, next), next); } catch (err) { next(err); }
  };
  proto[PATCHED] = true;
  return true;
}

/** `next('router')` / `next('route')` are routing signals, not failures. */
function isRoutingSignal(err: unknown): boolean {
  return err === 'router' || err === 'route';
}

function clientStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  const code = typeof status === 'number' ? status : statusCode;
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code < 500 ? code : null;
}

/**
 * The `next` a mount shell gives a module's router. Routing signals and
 * client errors (a 4xx `status`, e.g. malformed JSON from a body parser the
 * module mounted) keep Express's handling; anything else is the module's
 * failure, logged under its name and answered 500.
 */
export function routeErrorHandler(owner: string, req: Request, res: Response, next: NextFunction): NextFunction {
  return (err?: unknown) => {
    if (err === undefined || err === null || isRoutingSignal(err) || clientStatus(err) !== null) {
      next(err as Parameters<NextFunction>[0]);
      return;
    }
    console.error(`[http] ${owner}: ${req.method} ${req.originalUrl.split('?')[0]} failed:`, err);
    noteRequestError(res, err);
    if (res.headersSent) {
      // Mid-stream (SSE, chunked body): no status left to send, close it.
      if (!res.writableEnded) res.end();
      return;
    }
    res.status(500).json({ error: 'internal_error' });
  };
}
