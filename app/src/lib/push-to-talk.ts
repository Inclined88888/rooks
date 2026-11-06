/**
 * Push-to-talk: dictation stays open while a key is held.
 *
 * "Toggle" dictation (one click opens, one click closes) leaves the
 * microphone open while one thinks; holding a key makes the gesture explicit
 * and bounds listening to the length of speech. The key is a setting:
 * keyboards do not all have the same free keys, and the default (`Insert`)
 * does not exist on a Mac laptop.
 *
 * The preference is local to the device — a keyboard shortcut is not shared
 * between a desktop and a phone — hence `localStorage` rather than a daemon
 * setting.
 */

export const PUSH_TO_TALK_CLE = 'timon.stt.push-to-talk';
/** The setting changed in this tab: `storage` only notifies the OTHER ones. */
export const PUSH_TO_TALK_EVENT = 'timon:push-to-talk';

export type PushToTalkPrefs = {
  actif: boolean;
  /** `KeyboardEvent.code` — the physical key, independent of the keyboard
   *  layout: a binding set on AZERTY still holds on QWERTY. */
  code: string;
};

export const PUSH_TO_TALK_DEFAUT: PushToTalkPrefs = { actif: false, code: 'Insert' };

/**
 * Keys that are refused for capture: those that type (letters, digits, space)
 * and those the page needs for keyboard control. Binding them to the
 * microphone would cut the typing of the message dictation is meant to fill.
 */
export function toucheAutorisee(code: string): boolean {
  if (!code) return false;
  if (/^(Key|Digit|Numpad|Intl|Bracket|Quote|Semicolon|Comma|Period|Slash|Backslash|Minus|Equal|Backquote)/.test(code)) {
    return false;
  }
  return !['Space', 'Enter', 'NumpadEnter', 'Tab', 'Backspace', 'Delete', 'Escape'].includes(code);
}

/** Displayable label of a `code`, with no dictionary to maintain: the
 *  remaining codes (`Insert`, `F8`, `ShiftLeft`…) already read as they are,
 *  only the glued words are split. */
export function libelleTouche(code: string): string {
  if (!code) return '';
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function lirePushToTalk(raw: string | null): PushToTalkPrefs {
  if (!raw) return PUSH_TO_TALK_DEFAUT;
  try {
    const brut = JSON.parse(raw) as Partial<PushToTalkPrefs> | null;
    if (!brut || typeof brut !== 'object') return PUSH_TO_TALK_DEFAUT;
    const code = typeof brut.code === 'string' && toucheAutorisee(brut.code)
      ? brut.code
      : PUSH_TO_TALK_DEFAUT.code;
    return { actif: brut.actif === true, code };
  } catch {
    return PUSH_TO_TALK_DEFAUT;
  }
}

export function serialiserPushToTalk(prefs: PushToTalkPrefs): string {
  return JSON.stringify({ actif: prefs.actif, code: prefs.code });
}

export type ToucheEvenement = {
  code: string;
  /** Keyboard auto-repeat: dictation is already open. */
  repeat?: boolean;
};

/** True when this press must open (or close, on `keyup`) dictation. */
export function estDeclencheurPushToTalk(
  event: ToucheEvenement,
  prefs: PushToTalkPrefs,
): boolean {
  if (!prefs.actif) return false;
  if (event.repeat) return false;
  return event.code === prefs.code;
}

// ── Storage access (outside pure tests) ──────────────────────────────────

/** Last state read, and the raw text it comes from. `useSyncExternalStore`
 *  demands a STABLE reference as long as the value has not changed: returning
 *  a fresh object on every read would loop the render forever. */
let cacheBrut: string | null = null;
let cachePrefs: PushToTalkPrefs = PUSH_TO_TALK_DEFAUT;

export function chargerPushToTalk(): PushToTalkPrefs {
  if (typeof window === 'undefined') return PUSH_TO_TALK_DEFAUT;
  let brut: string | null;
  try {
    brut = window.localStorage.getItem(PUSH_TO_TALK_CLE);
  } catch {
    return PUSH_TO_TALK_DEFAUT;
  }
  if (brut === cacheBrut) return cachePrefs;
  cacheBrut = brut;
  cachePrefs = lirePushToTalk(brut);
  return cachePrefs;
}

export function enregistrerPushToTalk(prefs: PushToTalkPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PUSH_TO_TALK_CLE, serialiserPushToTalk(prefs));
  } catch {
    // Private browsing: the setting holds for the current session.
  }
  window.dispatchEvent(new CustomEvent(PUSH_TO_TALK_EVENT));
}

/** Subscription to changes, in this tab as in the others. */
export function abonnerPushToTalk(ecouteur: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const surStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PUSH_TO_TALK_CLE) ecouteur();
  };
  window.addEventListener(PUSH_TO_TALK_EVENT, ecouteur);
  window.addEventListener('storage', surStorage);
  return () => {
    window.removeEventListener(PUSH_TO_TALK_EVENT, ecouteur);
    window.removeEventListener('storage', surStorage);
  };
}
