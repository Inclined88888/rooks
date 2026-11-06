'use client';

/**
 * What an `updates.banner` occupant is painted for: a newer Timon, verified
 * by the daemon against the signed release list, that the person has not put
 * off. The slot passes no props, so the host (`UpdateBannerHost`) puts the
 * offer here and the occupant reads it with `useUpdateStatus()`.
 *
 * The host owns the decision to show anything at all — no offer, no banner —
 * and what "Later" remembers. The occupant paints; it never fetches, and
 * downloads only through `download`, which names nothing.
 */

import { createContext, useContext } from 'react';
import type { UpdateArtifact, UpdateOffer, UpdateStatus } from '@/lib/updates';
import type { UpdateDownloadControl } from '@/lib/update-download';

export type UpdateStatusValue = {
  /** The version this daemon runs. */
  installed: string;
  channel: UpdateStatus['channel'];
  /** The version offered, its plain-text notes and every installer published. */
  offer: UpdateOffer;
  /** The installers for this browser's system, the one to download first; empty on a phone or an unknown system. */
  installers: UpdateArtifact[];
  /** End of the running build, `null` when it never ends: the banner stands in for the expiry notice. */
  buildExpiresAt: string | null;
  /** Hides this version's banner on this machine; the next version is announced again. */
  later: () => void;
  /**
   * The desktop app downloads and verifies the installer itself (P2): start,
   * progress, cancel, then open the folder or the installer. `null` in a
   * browser, an older desktop, or a window on another machine: link
   * `installers[0]` then.
   */
  download: UpdateDownloadControl | null;
};

const UpdateStatusContext = createContext<UpdateStatusValue | null>(null);

export const UpdateStatusProvider = UpdateStatusContext.Provider;

/** Readable by a plugin that takes the `updates.banner` slot; `null` outside the host. */
export function useUpdateStatus(): UpdateStatusValue | null {
  return useContext(UpdateStatusContext);
}
