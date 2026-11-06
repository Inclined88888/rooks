/**
 * Gallery pictos of the bundled modules — the `timon.icon` a third-party
 * package ships as a file, written here as markup because `tsc` copies no
 * asset into `dist/`: an `.svg` beside the module would vanish from every
 * installer.
 *
 * Each entry is the BODY of a 24×24 line drawing; `pictoSvg` wraps it in the
 * one stroke style every picto shares. The card paints it as a mask in the
 * theme's text colour, so the stroke colour below is irrelevant — only the
 * shape counts. No text, no fill, nothing external.
 */
export function pictoSvg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

/** One per catalogue id — a test locks this list to `BUNDLED_IDENTITY`. */
export const BUNDLED_ICONS: Readonly<Record<string, string>> = Object.freeze({
  '@timon/db':
    '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  '@timon/settings':
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  '@timon/http':
    '<path d="M4.5 16a7.5 7.5 0 1 1 15 0"/><path d="M12 16l3.5-4"/><circle cx="12" cy="16" r="1.3"/><path d="M4 20h16"/>',
  '@timon/users':
    '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c.6-3 2.8-5 5.5-5s4.9 2 5.5 5"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6"/><path d="M17.5 14.6c1.6.7 2.7 2.4 3 4.9"/>',
  '@timon/plugins':
    '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 4v7M13 7.5h7"/>',
  '@timon/secrets-vault':
    '<rect x="3.5" y="4" width="17" height="15" rx="2"/><circle cx="12" cy="11.5" r="3.5"/><path d="M12 8v1.2M12 13.8V15M8.5 11.5h1.2M14.3 11.5h1.2"/><path d="M7 19v1.5M17 19v1.5"/>',
  '@timon/ui-layout':
    '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M9.5 9v11"/>',
  '@timon/ui-theme':
    '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-.9.7-1.6 1.7-1.6h2.2a3.8 3.8 0 0 0 3.8-3.8C20.5 6.9 16.7 3.5 12 3.5z"/><circle cx="7.8" cy="11.5" r=".9"/><circle cx="10" cy="7.6" r=".9"/><circle cx="14.6" cy="7.6" r=".9"/>',
  '@timon/backends':
    '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx=".6"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>',
  '@timon/agents':
    '<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 8V5.5"/><circle cx="12" cy="4.2" r="1.2"/><circle cx="9.5" cy="12.8" r=".9"/><circle cx="14.5" cy="12.8" r=".9"/><path d="M10 16h4"/><path d="M3 12.5v2.5M21 12.5v2.5"/>',
  '@timon/company':
    '<rect x="9" y="3.5" width="6" height="4.5" rx="1"/><rect x="3" y="16" width="6" height="4.5" rx="1"/><rect x="15" y="16" width="6" height="4.5" rx="1"/><path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>',
  '@timon/agents-projects':
    '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.3" r="1.9"/><path d="M8.7 17.5c.6-1.3 1.9-2 3.3-2s2.7.7 3.3 2"/>',
  '@timon/bots':
    '<path d="M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4 3.5v-3.5H6a2 2 0 0 1-2-2z"/><circle cx="9" cy="10.5" r=".9"/><circle cx="15" cy="10.5" r=".9"/><path d="M12 4.5V2.5"/>',
  '@timon/files-widget':
    '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M8 12h8M8 15.5h5"/>',
  '@timon/skills-widget':
    '<path d="M11 3.5l2.2 5.3 5.3 2.2-5.3 2.2L11 18.5l-2.2-5.3L3.5 11l5.3-2.2z"/><path d="M18.5 15.5v5M16 18h5"/>',
  '@timon/mcp-widget':
    '<path d="M9 3.5v4M15 3.5v4"/><path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 16v4.5"/>',
  '@timon/mcp-apps':
    '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><path d="M17 14v6M14 17h6"/>',
  '@timon/missions':
    '<path d="M12 3c3 2 4.5 5.2 4.5 9l-2 4h-5l-2-4C7.5 8.2 9 5 12 3z"/><circle cx="12" cy="9.5" r="1.6"/><path d="M7.5 12L5 14v3l3.5-1M16.5 12l2.5 2v3l-3.5-1M10.5 19l1.5 2 1.5-2"/>',
  '@timon/projects':
    '<path d="M3.5 9a2 2 0 0 1 2-2H9l2 2h7.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M6.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.5H18a1.5 1.5 0 0 1 1.5 1.5V9"/>',
  '@timon/notifications':
    '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  '@timon/web-push':
    '<rect x="6.5" y="3" width="11" height="18" rx="2.2"/><path d="M10.5 18h3"/><path d="M12 6.5v6M9.5 10l2.5 2.5 2.5-2.5"/>',
  '@timon/memory':
    '<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12l8.5 4.5 8.5-4.5"/><path d="M3.5 16l8.5 4.5 8.5-4.5"/>',
  '@timon/kanban':
    '<rect x="3.5" y="4" width="4.5" height="12" rx="1"/><rect x="9.75" y="4" width="4.5" height="8" rx="1"/><rect x="16" y="4" width="4.5" height="15.5" rx="1"/>',
  '@timon/todo-outcomes':
    '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 3h6v3H9z"/><path d="M8.5 13l2.5 2.5 4.5-5"/>',
  '@timon/git':
    '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9"/><path d="M17.5 9.5c0 3.5-2 5-5.5 5H9.5a3 3 0 0 0-3 2"/>',
  '@timon/kanban-code':
    '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M10 9.5L7.5 12l2.5 2.5"/><path d="M14 9.5l2.5 2.5-2.5 2.5"/>',
  '@timon/triggers':
    '<path d="M13.5 3L5.5 13.5h6L10.5 21l8-10.5h-6z"/>',
  '@timon/routines':
    '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4.5v4h-4"/><path d="M12 8v4.5l3 1.8"/>',
  '@timon/workflows':
    '<rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="4" width="6" height="5" rx="1"/><rect x="9" y="15" width="6" height="5" rx="1"/><path d="M9 6.5h6M6 9v2.5A1.5 1.5 0 0 0 7.5 13H12v2M18 9v2.5a1.5 1.5 0 0 1-1.5 1.5H12"/>',
  '@timon/dreams':
    '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/><path d="M16.5 3.5v3M15 5h3M20.2 8.5v2.4M19 9.7h2.4"/>',
  '@timon/agent-chat':
    '<path d="M3.5 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3 2.5V13h-.5a2 2 0 0 1-2-2z"/><path d="M15.5 8.5h3a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-.5v2.5L15 17h-3a2 2 0 0 1-2-2v-.5"/>',
  '@timon/resources-guard':
    '<path d="M12 3.5l7 2.8v5.2c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6.3z"/><path d="M8.5 14.5a3.5 3.5 0 0 1 7 0"/><path d="M12 14.5l1.8-2.2"/>',
  '@timon/vault':
    '<path d="M12 5.5a3 3 0 0 0-5.5-1A3 3 0 0 0 4 9a3 3 0 0 0 0 5 3 3 0 0 0 2.5 4.5A3 3 0 0 0 12 19.5z"/><path d="M12 5.5a3 3 0 0 1 5.5-1A3 3 0 0 1 20 9a3 3 0 0 1 0 5 3 3 0 0 1-2.5 4.5A3 3 0 0 1 12 19.5z"/><path d="M12 5.5v14"/><path d="M8 10.5c1 0 2 .7 2 2M16 10.5c-1 0-2 .7-2 2"/>',
  '@timon/grepai':
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3l5.2 5.2"/><path d="M10.5 7.3l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/>',
  '@timon/docker-supervision':
    '<rect x="3" y="10" width="5.4" height="5.4" rx=".8"/><rect x="9.3" y="10" width="5.4" height="5.4" rx=".8"/><rect x="9.3" y="3.7" width="5.4" height="5.4" rx=".8"/><rect x="15.6" y="10" width="5.4" height="5.4" rx=".8"/><path d="M3 19.5c3 1.3 6 1.3 9 0s6-1.3 9 0"/>',
  '@timon/browser-embedded':
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8.5h18"/><path d="M6 6.3h.01M8.3 6.3h.01"/><circle cx="12" cy="14.3" r="3.6"/><path d="M8.4 14.3h7.2M12 10.7c.9 1 1.4 2.3 1.4 3.6s-.5 2.6-1.4 3.6c-.9-1-1.4-2.3-1.4-3.6s.5-2.6 1.4-3.6z"/>',
  '@timon/browser-recording':
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8.5h18"/><circle cx="12" cy="14.3" r="3.2"/><circle cx="12" cy="14.3" r="1.2"/>',
  '@timon/browser-annotations':
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8.5h18"/><path d="M9 17.5l.6-2.6 5.2-5.2 2 2-5.2 5.2z"/>',
  '@timon/terminal-native':
    '<path d="M4.5 6.5l5.5 5.5-5.5 5.5M12.5 18h7"/>',
  '@timon/terminal-web':
    '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 8.5h18"/><path d="M7 12l2.5 2.2L7 16.4M11.5 16.5h5.5"/>',
  '@timon/ui-documents':
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8.5h18"/><path d="M9.5 11.5L7 14l2.5 2.5M14.5 11.5L17 14l-2.5 2.5"/>',
  '@timon/orchestrator-self':
    '<circle cx="12" cy="12.5" r="3"/><circle cx="12" cy="4" r="1.6"/><circle cx="19.5" cy="17" r="1.6"/><circle cx="4.5" cy="17" r="1.6"/><path d="M12 5.6v3.9M18.1 16.2l-3.5-2.1M5.9 16.2l3.5-2.1"/>',
  '@timon/web-app':
    '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M9 20.5h6M12 16.5v4"/><path d="M10 8l-2.3 2.3 2.3 2.3M14 8l2.3 2.3-2.3 2.3"/>',
  '@timon/telegram':
    '<path d="M20.5 3.5L3.5 10.3l6.4 2.6 2.6 6.6z"/><path d="M9.9 12.9l10.6-9.4"/>',
  '@timon/tts':
    '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  '@timon/gpt-live':
    '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/>',
  '@timon/video-factory':
    '<path d="M3.5 10h17v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M3.8 10l-.5-3.2a1.5 1.5 0 0 1 1.2-1.7l13.3-2.2a1.5 1.5 0 0 1 1.7 1.2l.4 2.4z"/><path d="M8.3 4.5l2.2 4M13.3 3.7l2.2 4"/>',
  // An arrow rising out of a tray: a newer version to fetch.
  '@timon/updates':
    '<path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/>',
  // A bar chart under an eye-less pulse: usage counted, nothing read.
  '@timon/telemetry':
    '<path d="M4 20h16"/><path d="M6.5 20v-5M11 20v-9M15.5 20v-6.5M20 20V7"/><path d="M4 9l4.5-4 4 3 5-4.5"/>',
  // Two computers, one link: the fleet of machines.
  '@timon/machines':
    '<rect x="2.5" y="4" width="8.5" height="6.5" rx="1.2"/><path d="M5 13.5h3.5M6.75 10.5v3"/><rect x="13" y="10" width="8.5" height="6.5" rx="1.2"/><path d="M15.5 19.5h3.5M17.25 16.5v3"/><path d="M11 7.25h2.5a1.5 1.5 0 0 1 1.5 1.5V10"/>',
});

/** `data:` URL of a bundled module's picto, or `null` when it has none. */
export function bundledIconUrl(id: string): string | null {
  const body = BUNDLED_ICONS[id];
  return body ? `data:image/svg+xml,${encodeURIComponent(pictoSvg(body))}` : null;
}
