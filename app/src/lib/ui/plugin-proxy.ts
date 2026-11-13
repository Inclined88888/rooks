/**
 * `ctx.api(path, init)` of a plugin's browser half → `/api/plugins/<id>/<path>`
 * on the daemon, where the plugin's own Express router answers every method.
 *
 * `ctx.api` is a bare `fetch`: a plugin may POST with no body at all
 * (`ctx.api('agents', { method: 'POST' })`) or send a query string, and the
 * proxy must relay both instead of choking on `request.json()`.
 *
 * A body typed as an archive (`PLUGIN_BINARY_BODY_TYPES`) is the one
 * exception to JSON: it is streamed to the plugin's route as bytes, bounded by
 * `PLUGIN_BINARY_BODY_MAX_BYTES`. Any other type keeps the JSON path, so a
 * plugin cannot smuggle an unbounded body through a type it made up.
 */
import { NextResponse } from 'next/server';
import { proxyJson, proxyRawBody } from './proxy';

/** Body types relayed as bytes. `x-zip-compressed` is what Windows browsers
 *  give a `.zip` `File`; `octet-stream` is what `ctx.api` sends for an
 *  untyped `Blob` or `ArrayBuffer`. */
export const PLUGIN_BINARY_BODY_TYPES: ReadonlySet<string> = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);

/**
 * 50 MiB: the largest archive a plugin route takes today (`agent-import`'s
 * `stage`, itself 10× a large real export). The relay holds no copy — it
 * streams — so the ceiling bounds what a browser can push through Next to a
 * daemon, not Next's memory; a route that wants less refuses on its own.
 */
export const PLUGIN_BINARY_BODY_MAX_BYTES = 50 * 1024 * 1024;

export interface PluginRouteParams {
  readonly id: string;
  readonly path: readonly string[];
}

export function pluginTarget({ id, path }: PluginRouteParams, search = ''): string {
  return `/api/plugins/${encodeURIComponent(id)}/${path.map(encodeURIComponent).join('/')}${search}`;
}

type BodyRead = { readonly ok: true; readonly body: unknown } | { readonly ok: false };

/** An empty body is an absent body; anything else must be JSON. */
export async function readOptionalJson(request: Request): Promise<BodyRead> {
  const text = await request.text();
  if (text.trim() === '') return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The archive type a body declares, normalised, or null for any other. */
export function binaryBodyType(request: Request): string | null {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return PLUGIN_BINARY_BODY_TYPES.has(type) ? type : null;
}

function tooLarge(): Response {
  const mib = PLUGIN_BINARY_BODY_MAX_BYTES / (1024 * 1024);
  return NextResponse.json({ error: `request body too large (max ${mib} MiB)`, code: 'body_too_large' }, { status: 413 });
}

/** Counts the bytes as they pass and fails the stream past the ceiling: a
 *  body sent without `Content-Length` (chunked) is bounded too. */
function bounded(body: ReadableStream<Uint8Array>, onExceeded: () => void): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > PLUGIN_BINARY_BODY_MAX_BYTES) {
        onExceeded();
        controller.error(new Error('request body too large'));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

async function proxyBinaryBody(method: string, request: Request, target: string, type: string): Promise<Response> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !/^\d{1,15}$/.test(declared)) {
    return NextResponse.json({ error: 'invalid Content-Length' }, { status: 400 });
  }
  // Refused on the header, before a byte of the body is read.
  if (declared !== null && Number(declared) > PLUGIN_BINARY_BODY_MAX_BYTES) return tooLarge();
  const headers: Record<string, string> = { 'content-type': request.headers.get('content-type') ?? type };
  if (declared !== null) headers['content-length'] = declared;
  if (request.body === null) return proxyRawBody(method, target, null, headers);
  let exceeded = false;
  try {
    return await proxyRawBody(method, target, bounded(request.body, () => { exceeded = true; }), headers);
  } catch (err) {
    if (exceeded) return tooLarge();
    throw err;
  }
}

export async function proxyPluginRequest(method: string, request: Request, params: PluginRouteParams): Promise<Response> {
  const target = pluginTarget(params, new URL(request.url).search);
  if (method === 'GET') return proxyJson('GET', target);
  const binary = binaryBodyType(request);
  if (binary !== null) return proxyBinaryBody(method, request, target, binary);
  const read = await readOptionalJson(request);
  if (!read.ok) return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  return proxyJson(method, target, read.body);
}
