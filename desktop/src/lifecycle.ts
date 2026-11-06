/** macOS users expect closing the only Timon window to free Timon.app for replacement. */
export function quitWhenLastWindowCloses(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}
