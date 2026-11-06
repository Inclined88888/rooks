/**
 * Which remote URLs Timon lets a user configure, and how a URL is shown back.
 *
 * Allow-list, not a deny-list: git understands far more than ssh and https —
 * `ext::<command>` runs a program, `fd::` reads a descriptor, an argument
 * starting with `-` becomes an option (`--upload-pack=…`). Only what a person
 * types to reach GitHub, GitLab, Gitea or their own server passes: ssh (URL or
 * `user@host:path`), https/http, git://, file:// and an absolute local path.
 *
 * Credentials never travel in a remote URL (docs/SECURITY.md): an https URL
 * with a user or a token is refused — git would store it in clear in
 * `.git/config` and echo it in every error — and an ssh URL may name its user
 * (`git@…`) but not a password. A remote configured outside Timon may still
 * carry one: `redactUrlCredentials` masks it wherever a URL is shown or an
 * error is relayed.
 */
import { isAbsolute } from 'node:path';

export type RemoteUrlKind = 'ssh' | 'https' | 'http' | 'git' | 'file' | 'path';

export type RemoteUrlRefusal =
  | 'empty'
  | 'too-long'
  | 'control-chars'
  | 'option'
  | 'credentials'
  | 'scheme'
  | 'host'
  | 'malformed';

export type RemoteUrlCheck =
  | { ok: true; url: string; kind: RemoteUrlKind }
  | { ok: false; reason: RemoteUrlRefusal };

export const REMOTE_URL_MAX = 2048;

/** Never quotes the URL: it may be the very secret being refused. */
export const REMOTE_URL_MESSAGES: Record<RemoteUrlRefusal, string> = {
  empty: 'remote URL is empty',
  'too-long': `remote URL is longer than ${REMOTE_URL_MAX} characters`,
  'control-chars': 'remote URL contains spaces or control characters',
  option: 'remote URL cannot start with "-"',
  credentials: 'remote URL carries credentials — use an SSH key or a git credential helper, never a user or token in the URL',
  scheme: 'unsupported remote URL scheme — use ssh://, user@host:path, https://, http://, git://, file:// or an absolute path',
  host: 'remote URL has no valid host',
  malformed: 'not a remote URL — use ssh://, user@host:path, https://, http://, git://, file:// or an absolute path',
};

const SCHEMES: Record<string, RemoteUrlKind> = {
  ssh: 'ssh',
  'git+ssh': 'ssh',
  'ssh+git': 'ssh',
  https: 'https',
  http: 'http',
  git: 'git',
  file: 'file',
};

// A host never starts with `-`: `ssh -oProxyCommand=…` is how a host
// becomes a command (CVE-2017-1000117).
const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9_][A-Za-z0-9._-]*)$/;
// git's scp-like syntax: a colon before the first slash, no `//` after it.
const SCP = /^(?:([^@/:]+)@)?(\[[0-9A-Fa-f:.]+\]|[^@/:[\]]+):(?!\/\/)(.+)$/;

export function checkRemoteUrl(raw: string): RemoteUrlCheck {
  const url = raw.trim();
  if (!url) return { ok: false, reason: 'empty' };
  if (url.length > REMOTE_URL_MAX) return { ok: false, reason: 'too-long' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(url)) return { ok: false, reason: 'control-chars' };
  if (url.startsWith('-')) return { ok: false, reason: 'option' };
  // `<transport>::<address>` hands the address to a remote helper; `ext::`
  // executes it.
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return { ok: false, reason: 'scheme' };

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme) {
    const kind = SCHEMES[scheme[1]!.toLowerCase()];
    if (!kind) return { ok: false, reason: 'scheme' };
    if (/\s/.test(url)) return { ok: false, reason: 'control-chars' };
    if (kind === 'file') return url.length > 'file://'.length ? { ok: true, url, kind } : { ok: false, reason: 'malformed' };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, reason: 'malformed' }; }
    if (parsed.password) return { ok: false, reason: 'credentials' };
    // A lone https user is a token as often as a name (`https://ghp_…@github.com`).
    if ((kind === 'https' || kind === 'http') && parsed.username) return { ok: false, reason: 'credentials' };
    if (!parsed.hostname || !HOST.test(parsed.hostname)) return { ok: false, reason: 'host' };
    if (!parsed.pathname || parsed.pathname === '/') return { ok: false, reason: 'malformed' };
    return { ok: true, url, kind };
  }

  // Checked before the scp form: on Windows `C:\repo` is a drive, not a host.
  if (isAbsolute(url)) return { ok: true, url, kind: 'path' };

  const scp = SCP.exec(url);
  if (scp) {
    if (/\s/.test(url)) return { ok: false, reason: 'control-chars' };
    const [, user, host, path] = scp;
    // `user:secret@host:repo` reads to git as host `user`, path `secret@…`:
    // the password would still land in `.git/config`.
    if (/^[^/]*@/.test(path!)) return { ok: false, reason: 'credentials' };
    if (user !== undefined && (!user || user.startsWith('-'))) return { ok: false, reason: 'host' };
    if (!HOST.test(host!)) return { ok: false, reason: 'host' };
    return { ok: true, url, kind: 'ssh' };
  }
  return { ok: false, reason: 'malformed' };
}

/**
 * Masks the credentials of every URL in a text — a stored remote URL or the
 * stderr of a git command, which quotes the URL it failed on. Everything else
 * is kept as is: git's own words are what tells a missing SSH key from an
 * unknown host.
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\s/@'"`]+)@/g,
    (match, scheme: string, userinfo: string) => {
      const web = /^https?$/i.test(scheme);
      return web || userinfo.includes(':') ? `${scheme}://***@` : match;
    },
  );
}
