'use client';

/**
 * The fleet, shared by every surface of the Machines plugin on screen: the
 * switcher is mounted twice (the rail and the mobile drawer), the settings
 * pane once more, and they must agree on the list without reading it three
 * times. One module-level value, subscribers, one request in flight at most.
 */
import { useEffect, useState } from 'react';
import { resetAddRequest } from '@/lib/machines/add-request';
import { listMachines, type FleetMachine } from '@/lib/machines/fleet';

// Moved to the core so that Settings → Devices can ask for the form without
// importing the plugin; re-exported for the plugin's own surfaces.
export { onAddRequest, requestAddMachine, takeAddRequest } from '@/lib/machines/add-request';

export type FleetState = {
  /** `null` until the first answer. */
  machines: FleetMachine[] | null;
  /** The last read failed (the list may be an older one). */
  failed: boolean;
};

let state: FleetState = { machines: null, failed: false };
let inFlight: Promise<void> | null = null;
const listeners = new Set<(next: FleetState) => void>();

function publish(next: FleetState): void {
  state = next;
  for (const listener of listeners) listener(next);
}

/** Reads the fleet again and tells every surface. Concurrent calls share one request. */
export function refreshFleet(): Promise<void> {
  if (inFlight) return inFlight;
  const request = listMachines().then((result) => {
    publish(result.ok ? { machines: result.value, failed: false } : { ...state, failed: true });
  }).finally(() => { inFlight = null; });
  inFlight = request;
  return request;
}

/** Replaces one machine in place (a rename, a fresh probe). */
export function updateFleetMachine(machine: FleetMachine): void {
  if (!state.machines) return;
  publish({ ...state, machines: state.machines.map((row) => (row.id === machine.id ? machine : row)) });
}

export function useFleet(): FleetState {
  const [current, setCurrent] = useState<FleetState>(state);
  useEffect(() => {
    listeners.add(setCurrent);
    setCurrent(state);
    if (state.machines === null) void refreshFleet();
    return () => { listeners.delete(setCurrent); };
  }, []);
  return current;
}

/** Tests only: back to a cold module. */
export function resetFleetStore(): void {
  state = { machines: null, failed: false };
  inFlight = null;
  resetAddRequest();
}
