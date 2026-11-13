/** macOS users expect closing the only Rooks window to free Rooks.app for replacement. */
export function quitWhenLastWindowCloses(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}
