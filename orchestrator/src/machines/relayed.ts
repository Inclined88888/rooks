/**
 * How a notification relayed from another machine of the fleet is marked
 * (`push-relay.ts`). Its own file: the Web Push module reads the mark, and
 * must not pull the relay (streams, vault, fleet) in to do so.
 */
export const RELAY_SOURCE_PREFIX = 'machine:';

/** `source` of a relayed card. */
export const relayedSource = (machineId: string): string => `${RELAY_SOURCE_PREFIX}${machineId}`;

/** `anchor` of a relayed card: the one local copy of one remote card. */
export const relayedAnchor = (machineId: string, remoteId: string): string => `${RELAY_SOURCE_PREFIX}${machineId}:${remoteId}`;

/** The machine a relayed card came from, or `null` for a card of this daemon. */
export function relayedMachineId(source: string | null | undefined): string | null {
  if (!source || !source.startsWith(RELAY_SOURCE_PREFIX)) return null;
  const id = source.slice(RELAY_SOURCE_PREFIX.length);
  return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
}
