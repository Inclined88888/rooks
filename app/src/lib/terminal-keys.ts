/**
 * Copy and paste shortcuts of the built-in terminal. In a shell Ctrl+C is
 * SIGINT, so copying needs another chord, and each OS has its own habit:
 * Cmd+C / Cmd+V on macOS, Ctrl+Shift+C / Ctrl+Shift+V on Linux and Windows,
 * plus Ctrl+C on a selection on Windows (as in Windows Terminal).
 */

export type TerminalPlatform = 'mac' | 'windows' | 'other';

export type TerminalClipboardAction = 'copy' | 'paste';

export type TerminalKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

type NavigatorLike = { platform?: string; userAgentData?: { platform?: string } };

export function detectTerminalPlatform(nav: NavigatorLike | undefined = typeof navigator === 'undefined' ? undefined : navigator): TerminalPlatform {
  const name = (nav?.userAgentData?.platform || nav?.platform || '').toLowerCase();
  // iPadOS and iOS hardware keyboards use Cmd too.
  if (name.startsWith('mac') || name.startsWith('iphone') || name.startsWith('ipad') || name === 'ios') return 'mac';
  if (name.startsWith('win')) return 'windows';
  return 'other';
}

/**
 * The letter of the key, whatever the layout: `key` on a latin layout (an
 * upper-case one with Shift), the physical key on another (Cyrillic, Greek…),
 * where `key` holds a letter the shortcut does not name.
 */
function letterOf(event: TerminalKeyEvent): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(event.code);
  return physical ? physical[1]!.toLowerCase() : null;
}

/**
 * The clipboard action a key chord stands for in the terminal, or null when
 * it is an ordinary key for the shell. Ctrl+C without a selection stays
 * SIGINT everywhere, and Ctrl+V stays ^V.
 */
export function terminalClipboardAction(event: TerminalKeyEvent, platform: TerminalPlatform, hasSelection: boolean): TerminalClipboardAction | null {
  if (event.altKey) return null;
  const letter = letterOf(event);
  if (letter !== 'c' && letter !== 'v') return null;
  if (platform === 'mac') {
    if (!event.metaKey || event.ctrlKey || event.shiftKey) return null;
    if (letter === 'v') return 'paste';
    return hasSelection ? 'copy' : null;
  }
  if (!event.ctrlKey || event.metaKey) return null;
  if (event.shiftKey) return letter === 'c' ? 'copy' : 'paste';
  if (letter === 'c' && platform === 'windows' && hasSelection) return 'copy';
  return null;
}
