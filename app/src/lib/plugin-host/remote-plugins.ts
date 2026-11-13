/**
 * Third-party plugins of a remote machine (TODO #329, P4d).
 *
 * The interface of another machine runs on THIS origin, with this computer's
 * session. A plugin's browser half is code: loaded from the remote daemon, a
 * compromised machine of the fleet would run its own JavaScript here and act
 * on this computer with the local session. So, when the active machine is a
 * remote one, a third-party plugin's browser half is mounted only when the
 * SAME plugin is installed and running here — same id, same `version`, same
 * Ed25519 `signature.hash` — and it is always THIS computer's copy that loads
 * (`/api/ui/plugin-bundles/<id>` is anchored on the local daemon). Otherwise
 * the half stays off and the gallery says it is waiting for approval here.
 *
 * Its API calls (`/api/ui/plugins/<id>/…`) still go to the remote machine:
 * that is where its host half, and its data, live.
 *
 * Built-in plugins (`orchestrator/builtin-plugins.json`: quota monitor, Hermes
 * gateway…) are third-party packages shipped inside the release, trusted by
 * where they live rather than by a signature: they publish none (TIM-0135).
 * Their twin is the local built-in of the same id, version AND browser-half
 * code. The code that runs is still this computer's copy, vouched for by this
 * computer's release; the comparison makes sure it is the very code the remote
 * machine's own interface runs against its host half — two Rooks releases may
 * ship different code under an unchanged package version. Code identity is
 * `client.digest` (line endings folded: a committed `lib/client.js` checked out
 * with CRLF on a Windows build machine keeps one identity on every OS), or, from
 * a daemon too old to publish it, `client.rev` — equal bytes, equal code.
 *
 * Bundled modules are untouched: their halves are compiled into this app and
 * the daemon publishes no `client` for them.
 */

/** What both machines say of a plugin, as `GET /api/plugins` returns it. A
 *  daemon older than P4c sends no `signature`: never a match. */
export interface PluginIdentity {
  readonly id: string;
  readonly state: string;
  readonly version?: string;
  readonly signature?: { readonly hash: string } | null;
  /** Shipped with the product (`builtin.ts`). Absent from a daemon older
   *  than built-ins: never a built-in twin. */
  readonly builtin?: boolean;
  readonly client: { readonly rev?: string; readonly digest?: string } | null;
}

/** Same browser-half code on both sides (see the header). */
function sameCode(remote: NonNullable<PluginIdentity['client']>, local: NonNullable<PluginIdentity['client']>): boolean {
  if (remote.digest && local.digest) return remote.digest === local.digest;
  return Boolean(remote.rev) && remote.rev === local.rev;
}

/** The local plugin a remote one's browser half may be mounted from, or
 *  `null` when it has to wait for approval on this computer. */
export function localTwin<T extends PluginIdentity>(remote: PluginIdentity, locals: readonly T[]): T | null {
  if (!remote.client || !remote.version) return null;
  const twin = locals.find((plugin) => plugin.id === remote.id);
  if (!twin || twin.state !== 'active' || !twin.client) return null;
  if (twin.version !== remote.version) return null;
  if (remote.builtin === true && twin.builtin === true) return sameCode(remote.client, twin.client) ? twin : null;
  const hash = remote.signature?.hash;
  if (!hash || twin.signature?.hash !== hash) return null;
  return twin;
}

/**
 * The remote list as this computer may mount it: a matched plugin carries the
 * LOCAL `client` (its bundle revision, slots and permissions are those of the
 * code that will run), any other browser half is dropped.
 */
export function mountableOnRemote<T extends PluginIdentity, L extends PluginIdentity & { readonly client: T['client'] }>(
  remote: readonly T[],
  locals: readonly L[],
): T[] {
  return remote.map((plugin) => {
    if (!plugin.client) return plugin;
    const twin = localTwin(plugin, locals);
    return { ...plugin, client: twin ? twin.client : null };
  });
}

/** Ids of the remote plugins whose browser half waits for approval here:
 *  running there, with a browser half, and no matching local copy. */
export function awaitingLocalApproval(remote: readonly PluginIdentity[], locals: readonly PluginIdentity[]): Set<string> {
  return new Set(remote
    .filter((plugin) => plugin.state === 'active' && plugin.client && !localTwin(plugin, locals))
    .map((plugin) => plugin.id));
}
