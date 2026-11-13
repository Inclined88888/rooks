'use client';

/**
 * What a `directory.picker` occupant is painted for: one request for a folder
 * of the ACTIVE machine (TIM-0136), from Settings, a project or an agent — or
 * for a file (TODO #791): a plugin archive, a CLI binary.
 *
 * The slot passes no props — an entry is registered once and painted by every
 * host — so the host (`useDirectoryPicker()`) puts its value here and the
 * occupant reads it with `useDirectoryBrowser()`. The host owns the daemon's
 * calls and the request's outcome: `read` lists one level, every path built by
 * the daemon that will read the chosen one; the occupant paints the levels and
 * hands one back with `choose`. It never builds a path itself.
 */

import { createContext, useContext } from 'react';
import type { DirectoryRead } from '@/lib/directory-pick';

export type DirectoryBrowserValue = {
  /**
   * `directory`: the form wants a folder. `file` (TODO #791): it wants a file,
   * listed in `listing.files`; `choose` then takes a file the host served.
   */
  mode: 'directory' | 'file';
  /** File mode: the endings the form takes (`.tgz`…), already applied by the daemon; `[]` for any file. */
  accept: readonly string[];
  /** The folder (or, in file mode, the file) the form holds; `''` when it holds none. */
  initialPath: string;
  /** The first level to show: `initialPath` when the daemon can read it, otherwise its home. */
  opening: () => Promise<DirectoryRead>;
  /** One level of the active machine's disk; `null` asks for the daemon's home. */
  read: (path: string | null) => Promise<DirectoryRead>;
  /**
   * Hands `path` back to the form and closes: a `listing.path` or an entry's
   * `path` in folder mode; a file's `path` or `listing.selected` in file mode,
   * where any other path is ignored.
   */
  choose: (path: string) => void;
  /** Closes without changing the form. */
  cancel: () => void;
};

const DirectoryBrowserContext = createContext<DirectoryBrowserValue | null>(null);

export const DirectoryBrowserProvider = DirectoryBrowserContext.Provider;

/** Readable by a plugin that takes the `directory.picker` slot; `null` outside a host. */
export function useDirectoryBrowser(): DirectoryBrowserValue | null {
  return useContext(DirectoryBrowserContext);
}
