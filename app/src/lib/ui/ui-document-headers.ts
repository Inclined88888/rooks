/**
 * Headers the Next proxy relays with a document's HTML (ADR-MCPUI D3, D4).
 *
 * A white list, like `proxyMedia`: the daemon's CSP (with its `sandbox`
 * directive) is what keeps the document an opaque origin even when opened in a
 * tab of its own, so it must survive the hop — and nothing else the upstream
 * says may ride along, `set-cookie` above all. A response whose CSP does not
 * open with `sandbox` (an error page, a daemon of another version) gets the
 * strictest policy instead: it is shown nowhere, but it is still served on the
 * app's origin.
 */

const RELAYED = [
  'content-type', 'content-security-policy', 'x-content-type-options', 'referrer-policy',
  'cross-origin-resource-policy', 'permissions-policy',
] as const;

export const LOCKED_DOCUMENT_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";

export function uiDocumentProxyHeaders(upstream: Headers, ok: boolean): Headers {
  const out = new Headers();
  for (const name of RELAYED) {
    const value = upstream.get(name);
    if (value) out.set(name, value);
  }
  const csp = out.get('content-security-policy') ?? '';
  if (!ok || !/^\s*sandbox(?:\s|;|$)/i.test(csp)) out.set('content-security-policy', LOCKED_DOCUMENT_CSP);
  out.set('x-content-type-options', 'nosniff');
  out.set('cache-control', 'private, no-store');
  if (!out.has('referrer-policy')) out.set('referrer-policy', 'no-referrer');
  return out;
}
