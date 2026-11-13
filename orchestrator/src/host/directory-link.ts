import { symlinkSync } from 'node:fs';
import { resolve } from 'node:path';

export function linkDirectory(target: string, destination: string): void {
  // Junctions do not require Windows symlink privileges or Developer Mode.
  symlinkSync(resolve(target), destination, process.platform === 'win32' ? 'junction' : 'dir');
}
