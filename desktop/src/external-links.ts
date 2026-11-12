/**
 * What the Rooks window does with a link it was about to follow (TIM-0051).
 *
 * The window shows the app and nothing else: it has no address bar, no menu and
 * no back button. A link without `target="_blank"` (a PR in an agent's message,
 * a docs link in rendered HTML) used to navigate the window itself to GitHub,
 * leaving the user stranded outside Rooks with no way back. Anything that is
 * not the app's own origin goes to the system browser instead.
 */

/** Schemes worth handing to the OS; anything else (file:, javascript:, custom handlers) is dropped. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export type LinkAction =
  | { kind: 'allow' }
  | { kind: 'external'; url: string }
  | { kind: 'block' };

/** The URL to open in the system browser, or null when its scheme is not one we hand out. */
export function externalUrl(target: string): string | null {
  try {
    const parsed = new URL(target);
    return EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Decides a main-frame navigation of the Rooks window. */
export function navigationAction(target: string, windowOrigin: string): LinkAction {
  let parsed: URL;
  try { parsed = new URL(target); } catch { return { kind: 'block' }; }
  if (windowOrigin !== '' && parsed.origin === windowOrigin) return { kind: 'allow' };
  const url = externalUrl(target);
  return url ? { kind: 'external', url } : { kind: 'block' };
}
