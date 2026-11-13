/**
 * Tells the desktop shell the light/dark mode this page paints (multi-window):
 * each machine keeps its own, and the next window or page the shell opens on
 * this machine paints that background before the page answers, instead of
 * flashing this computer's. A mode and the machine the page was served for —
 * the shell prefers its window's pin. Nothing on the web or in the PWA, and an
 * older desktop without the channel is left alone.
 */
import type { ColorScheme } from '@/lib/auth';
import { activeMachineId } from '@/lib/machines/machine-storage';

export function reportWindowScheme(scheme: ColorScheme): void {
  if (typeof window === 'undefined') return;
  const bridge = window.rooksDesktop?.windowScheme;
  if (typeof bridge !== 'function') return;
  try {
    void bridge({ scheme, machineId: activeMachineId() }).catch(() => {});
  } catch {
    /* an older shell: its window keeps the install's background */
  }
}
