import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { pageRequiresLogin } from './lib/auth';
import { clientOrigin } from './lib/client-origin';
import { readSessionToken } from './lib/ui/proxy-auth';
import { URL_HEADER } from './lib/workspace-route';

/**
 * Central gate for the browser: no session cookie → `/login`. API routes
 * are left alone so a 401 stays JSON; the client shell then routes to
 * `/login` (see `AuthRedirect`). The API catch-all rejects unknown API paths
 * before they can reach the plugin page shell.
 *
 * The redirect is absolute and built on the origin the CLIENT used, not on
 * `req.nextUrl` (step 5.9.6). Two failures are being avoided at once:
 *
 *   - `NextResponse.redirect(req.nextUrl)` (before 5.9.1) sent a browser that
 *     had opened `127.0.0.1:3110` over to `localhost:3110`: that URL is
 *     composed by the server from its own bind address, so it never carries
 *     the host the browser used. See `lib/client-origin.ts`.
 *   - A relative `Location` (5.9.1) never reaches the browser at all: the
 *     middleware adapter reparses the header with `new NextURL(location,
 *     opts)`, with no base, and throws `Invalid URL` — every page of the
 *     packaged AppImage answered HTTP 500.
 *
 * The origin then survives the adapter untouched thanks to
 * `skipMiddlewareUrlNormalize` (see `next.config.mjs`): without it the adapter
 * rewrites our `Location` into Next's normalized form, which folds every
 * loopback name back into `localhost`.
 */
export function redirectTo(req: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, clientOrigin(req.headers, req.nextUrl.origin)), 307);
}

/**
 * Passes the request through with the requested URL added, preserving what
 * came in.
 *
 * A root layout has no access to the pathname or the query string — Next hands
 * those to pages only. Without them, the server cannot tell which workspace is
 * being opened, so it cannot resolve its scope, so every stored value (cards,
 * columns, canvas) has to be fetched by the browser after hydration. This
 * header is what lets the layout resolve them BEFORE the first paint.
 */
function withUrl(req: NextRequest): NextResponse {
  const headers = new Headers(req.headers);
  headers.set(URL_HEADER, req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export function middleware(req: NextRequest): NextResponse {
  if (!pageRequiresLogin(req.nextUrl.pathname)) return withUrl(req);
  const session = readSessionToken((name) => req.cookies.get(name)?.value);
  if (session) return withUrl(req);
  return redirectTo(req, '/login');
}

export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|logo-|icon-|manifest|sw\\.js|workbox|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|json)$).*)',
  ],
};
