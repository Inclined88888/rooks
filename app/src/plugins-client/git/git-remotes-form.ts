/**
 * What the remotes dialog checks before sending anything (TODO #278).
 *
 * The daemon decides (`orchestrator/src/git-remote-url.ts`); this only spares
 * the round trip for the two mistakes a person makes most, and keeps a token
 * pasted in an https URL from leaving the field at all.
 */

export type RemoteFormIssue = 'name' | 'url' | 'credentials' | null;

/** Same rule as the daemon: what a person types, never an option. */
export function validRemoteName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(name)
    && !name.includes('..') && !name.endsWith('.') && !name.endsWith('.lock');
}

/** An http(s) URL with any user part: a token sits there as often as a name. */
export function urlCarriesCredentials(url: string): boolean {
  const m = /^\s*https?:\/\/([^/?#]*)@/i.exec(url);
  if (m) return true;
  // `ssh://user:secret@host/…`: a user is fine over ssh, a password is not.
  return /^\s*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@?#]*:[^/@?#]*@/.test(url);
}

/** The first issue blocking the save, or null. An empty field is not an
 *  issue to shout about: the button simply stays disabled. */
export function remoteFormIssue(name: string, url: string): RemoteFormIssue {
  if (name.trim() && !validRemoteName(name.trim())) return 'name';
  if (urlCarriesCredentials(url)) return 'credentials';
  // An option, or a `<transport>::` helper (`ext::` runs a command): never a remote.
  const u = url.trim();
  if (u.startsWith('-') || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(u)) return 'url';
  return null;
}
