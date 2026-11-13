/**
 * What a secret looks like in an MCP address or command line, and how it is
 * taken out: the value goes, its name stays (for the user to enter it again in
 * the vault). Shared by every source and by the preview, so a secret is masked
 * the same way wherever it shows.
 */

/** A name that announces a secret: its value is not carried, the name is listed instead. */
export const SECRETISH = /(token|secret|passw|pwd|api[-_]?key|apikey|auth|credential|bearer|private[-_]?key|access[-_]?key|session|cookie|signature|^sig$)/i;
/** Prefixes of well-known credentials, in case one is written bare on a command line. */
export const BARE_TOKEN = /^(sk-|sk_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA[0-9A-Z]{12}|ya29\.|Bearer\s)/;
export const REDACTED = '<redacted>';

/** What a credential written in an address' path is listed as: it has no name of its own. */
export const PATH_TOKEN_NAME = 'URL path token';

const decoded = (segment: string): string => {
  try { return decodeURIComponent(segment); } catch { return segment; }
};

/**
 * The address without its credentials: user info, secret-looking query
 * parameters and path segments shaped like a known credential
 * (`https://h/sk-…/mcp`) become names.
 */
export function sanitizeUrl(raw: string, secrets: Set<string>): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) {
    secrets.add('URL credentials');
    url.username = '';
    url.password = '';
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRETISH.test(key)) {
      secrets.add(key);
      url.searchParams.delete(key);
    }
  }
  if (url.hash && SECRETISH.test(url.hash)) url.hash = '';
  const segments = url.pathname.split('/');
  if (segments.some((segment) => BARE_TOKEN.test(decoded(segment)))) {
    secrets.add(PATH_TOKEN_NAME);
    url.pathname = segments.map((segment) => (BARE_TOKEN.test(decoded(segment)) ? REDACTED : segment)).join('/');
  }
  return url.href;
}

/** A command line with the values of secret-looking flags and bare credentials replaced. */
export function redactArgs(args: readonly string[], secrets: Set<string>): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const arg of args) {
    if (hideNext) {
      out.push(REDACTED);
      hideNext = false;
      continue;
    }
    const flag = /^(--?[A-Za-z0-9][\w.-]*)(=)?/.exec(arg);
    if (flag) {
      if (SECRETISH.test(flag[1]!)) {
        secrets.add(flag[1]!.replace(/^-+/, ''));
        if (flag[2]) out.push(`${flag[1]}=${REDACTED}`);
        else {
          out.push(arg);
          hideNext = true;
        }
        continue;
      }
      out.push(arg);
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(arg);
    if (assignment && SECRETISH.test(assignment[1]!)) {
      secrets.add(assignment[1]!);
      out.push(`${assignment[1]}=${REDACTED}`);
      continue;
    }
    if (BARE_TOKEN.test(arg)) {
      out.push(REDACTED);
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      out.push(sanitizeUrl(arg, secrets) ?? REDACTED);
      continue;
    }
    out.push(arg);
  }
  return out;
}
