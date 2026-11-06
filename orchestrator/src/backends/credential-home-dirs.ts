/**
 * Which folders of the home hold whose credentials: the built-in backends' sign-in
 * folders and the user's own credential stores. Pure data and path arithmetic —
 * a leaf on purpose, because the published SDK validates a provider's
 * `declares.credentialDirs` with it (`provider-declarations.ts`), and the host
 * adapter (`host/isolation.ts`) masks and spares folders by the same tables.
 */

type HomeDirTable = Readonly<Record<string, readonly string[]>>;

let backendHomeDirsSource: (() => HomeDirTable) | null = null;
let fallbackHomeDirs: HomeDirTable = {};

/**
 * Where the sign-in folders of the product's own backends come from: the daemon installs its
 * declarations here (`builtin-declarations.ts`, read from the manifests of the official provider
 * plugins), and they win over any fallback.
 */
export function setBackendHomeDirsSource(source: () => HomeDirTable): void {
  backendHomeDirsSource = source;
}

/**
 * The table of a process no daemon started: the published SDK ships no manifest, so its testing kit
 * hands over the copy generated from them (`packages/sdk/src/product-credential-dirs.ts`), and a
 * provider's own test is refused `.claude` as the daemon would refuse it at registration. Ignored
 * once the daemon installed its source, whichever came first.
 */
export function setBackendHomeDirsFallback(table: HomeDirTable): void {
  fallbackHomeDirs = table;
}

/** Credential folders of each of the product's own backends, relative to the home folder, by backend id. */
export function backendHomeDirs(): HomeDirTable {
  return backendHomeDirsSource ? backendHomeDirsSource() : fallbackHomeDirs;
}

/**
 * Folders (relative to the home, `/`-separated) a provider can NEVER declare as
 * its own credential folder (`declares.credentialDirs`), nor sit above or inside:
 * the OS-wide credentials above plus the usual stores of other tools. A declared
 * folder is spared from the mission mask and is the root `scratch.link` reads
 * from, so accepting `.ssh` — or `.config`, which holds `.config/gcloud` — would
 * hand a third-party plugin the user's keys. Compared by segment, case-insensitively.
 */
export const PROTECTED_HOME_DIRS: readonly string[] = Object.freeze([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.config/gh',
  '.kube',
  '.docker',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.password-store',
  '.local/share/keyrings',
  'Library/Keychains',
  '.pkos', // public-name-ok: the archive's home is never a provider's
  '.timon',
  '.timon-dev',
]);

/** Folders that only CONTAIN tools' folders: a credential folder needs a segment that is not one of these. */
const GENERIC_HOME_SEGMENTS: readonly string[] = ['.config', '.local', '.cache', 'share', 'state', 'cache', 'library', 'application support', 'appdata', 'roaming', 'local'];

function homeSegments(dir: string): string[] {
  return dir.split('/').map((s) => s.toLowerCase());
}

function segmentsStartWith(whole: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= whole.length && prefix.every((s, i) => whole[i] === s);
}

/** `dir` is, contains or lies inside one of `others` (by segment, case-insensitive). */
function overlapsHomeDir(dir: string, others: Iterable<string>): string | null {
  const own = homeSegments(dir);
  for (const other of others) {
    const theirs = homeSegments(other);
    if (segmentsStartWith(own, theirs) || segmentsStartWith(theirs, own)) return other;
  }
  return null;
}

/**
 * Why `dir` (relative to the home) can be nobody's credential folder, or null:
 * not a protected folder or a parent of one, and owned by a product (at least one
 * segment that is not a bare container such as `.config`). The shape of the string
 * is the caller's to check (`provider-declarations.ts`).
 */
export function protectedHomeDirProblem(dir: string): string | null {
  const hit = overlapsHomeDir(dir, PROTECTED_HOME_DIRS);
  if (hit) return `\`${dir}\` is, contains or lies inside \`${hit}\`, which holds credentials that belong to the user, not to a provider`;
  if (homeSegments(dir).every((s) => GENERIC_HOME_SEGMENTS.includes(s))) {
    return `\`${dir}\` is a bare container: a credential folder needs a segment of its own (\`.acme\`, \`.config/acme\`)`;
  }
  return null;
}

/**
 * Why a provider may not claim `dir`: it is the folder of ANOTHER built-in backend.
 * `ownIds` is every id the claimant answers for — its dialect id, or the id of the
 * PROFILE that names the folder (`ollama-cloud` runs on the `codex` dialect and owns
 * `.ollama`, which the dialect's id would not get it past). The caller passes only
 * ids the same plugin registered: a stranger naming `claude` gets `.claude` nowhere. `table` is the
 * product's own folders unless the caller is building that table.
 */
export function otherBackendHomeDirProblem(
  dir: string, ownIds?: string | readonly string[], table: HomeDirTable = backendHomeDirs(),
): string | null {
  const own = typeof ownIds === 'string' ? [ownIds] : ownIds ?? [];
  for (const [backend, dirs] of Object.entries(table)) {
    if (own.includes(backend)) continue;
    const owned = overlapsHomeDir(dir, dirs);
    if (owned) return `\`${dir}\` overlaps \`${owned}\`, the credential folder of the \`${backend}\` backend`;
  }
  return null;
}
