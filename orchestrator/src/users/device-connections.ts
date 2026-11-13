/**
 * The long-lived connections a paired device holds open on this daemon: a web
 * terminal, an event stream (multi-machine, TODO #329).
 *
 * A device token is checked when a connection OPENS. Revoking the device stops
 * the next request, but a WebSocket already open is a shell that
 * would outlive the revocation — the very thing revocation is for. So every
 * such connection is registered here with the way to close it, and is closed:
 *  - at once when the device is revoked (`revokeDevice`);
 *  - within `DEVICE_CONNECTION_SWEEP_MS` when it dies otherwise (idle expiry,
 *    owner disabled or deleted), by the sweep the users module runs
 *    (`sweepDeviceConnections`, `devices.ts`).
 *
 * A pure registry: it knows nothing of the devices table, so the low-level
 * `devices.ts` can import it.
 */
export const DEVICE_CONNECTION_SWEEP_MS = 60_000;

export type DeviceConnectionKind = 'terminal' | 'events';

type Entry = { kind: DeviceConnectionKind; close: () => void };

const live = new Map<string, Set<Entry>>();

/**
 * Registers one open connection of `deviceId`. Returns the function that
 * forgets it, to call when the connection ends on its own.
 */
export function trackDeviceConnection(deviceId: string, kind: DeviceConnectionKind, close: () => void): () => void {
  const entry: Entry = { kind, close };
  let set = live.get(deviceId);
  if (!set) {
    set = new Set();
    live.set(deviceId, set);
  }
  set.add(entry);
  return () => {
    const current = live.get(deviceId);
    if (!current) return;
    current.delete(entry);
    if (current.size === 0) live.delete(deviceId);
  };
}

/** Closes every open connection of one device. Returns how many were closed. */
export function closeDeviceConnections(deviceId: string): number {
  const set = live.get(deviceId);
  if (!set) return 0;
  live.delete(deviceId);
  let closed = 0;
  for (const entry of set) {
    try {
      entry.close();
    } catch {
      // A connection already half gone: nothing left to close.
    }
    closed++;
  }
  if (closed > 0) console.log(`[devices] ${closed} open connection(s) of device ${deviceId.slice(0, 8)} closed`);
  return closed;
}

/** Open connections per device, for the tests and the diagnostics. */
export function deviceConnectionCount(deviceId?: string): number {
  if (deviceId !== undefined) return live.get(deviceId)?.size ?? 0;
  let total = 0;
  for (const set of live.values()) total += set.size;
  return total;
}

/** Devices that hold at least one open connection. */
export function trackedDeviceIds(): string[] {
  return [...live.keys()];
}
