/**
 * Programs the DAEMON put on this machine for a backend, and where they came from (TODO #531, 3-B).
 *
 * A third-party backend's launch is held to the operator's allowlist (`launch-binary.ts`). An agent
 * downloaded from the ACP registry is on no PATH and in no operator list: the daemon fetched it,
 * checked it and registered its profile with the absolute command. That origin is recorded here,
 * typed, for the profile it was registered for — never inferred from a folder or a name — so its
 * launch is compared to exactly that file, and to nothing else. The record goes with the registration
 * (uninstall, update, a failed restore), which is what makes a withdrawal effective.
 */

export type LaunchProvenance = {
  /** Who installed the program. One source today; a new one is a decision, not a string. */
  readonly source: 'acp-registry';
  /** The absolute command the profile was registered with. */
  readonly path: string;
  /** The version the daemon installed, for the refusal a person reads. */
  readonly version: string;
};

const provenances = new Map<string, { provenance: LaunchProvenance; token: symbol }>();

/** Records the program the daemon installed for profile `profileId`; the returned function withdraws it. */
export function registerLaunchProvenance(profileId: string, provenance: LaunchProvenance): () => void {
  const token = Symbol(profileId);
  provenances.set(profileId, { provenance: { ...provenance }, token });
  return () => {
    // A newer registration (an update swapped in) is not this one's to withdraw.
    if (provenances.get(profileId)?.token === token) provenances.delete(profileId);
  };
}

/** The program the daemon installed for profile `profileId` (an account instance passes its base id), if any. */
export function launchProvenance(profileId: string): LaunchProvenance | undefined {
  return provenances.get(profileId)?.provenance;
}
