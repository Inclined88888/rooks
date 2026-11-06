/**
 * The `init` `ctx.api` hands to `fetch`. A browser sends a `File` with its
 * type, but an `ArrayBuffer`, a typed array or a `Blob` built without one
 * goes out with no `Content-Type` at all, and the plugin proxy would then
 * read the bytes as JSON. Such a body is named `application/octet-stream`,
 * the one binary type every plugin route can expect. A type the plugin set
 * itself is never replaced.
 */
export function typedBinaryInit(init: RequestInit | undefined): RequestInit | undefined {
  const body = init?.body;
  if (!init || body === undefined || body === null) return init;
  const untyped = body instanceof Blob ? body.type === '' : body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  if (!untyped) return init;
  const headers = new Headers(init.headers);
  if (headers.has('content-type')) return init;
  headers.set('content-type', 'application/octet-stream');
  return { ...init, headers };
}
