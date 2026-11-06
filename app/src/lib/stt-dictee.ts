/**
 * Grace window of the chat's dictation.
 *
 * The Web Speech engine ends its turn at the FIRST pause in speech: one second
 * of hesitation and `onend` fires, dictation stops, the microphone has to be
 * pressed again. This module holds the rule that decides, on `onend`, whether
 * listening restarts (the user is looking for words) or really closes.
 *
 * It lives here, outside React, because it is the only testable part of the
 * mechanism: the rest is only wiring of browser callbacks.
 */

import { isLocalDictationError } from './dictation/errors';
import { fusionnerSegments } from './stt-transcript';

/** Silence tolerated before dictation ends on its own. An ordinary hesitation
 *  lasts one to two seconds; four leave time to resume without making someone
 *  who has finished speaking wait forever. Single source: the inactivity timer
 *  AND the `onend` restart test read this value. */
export const DICTEE_GRACE_MS = 4_000;

/** The engine refuses `start()` until the previous instance is released
 *  (`InvalidStateError`): one tick passes before restarting. Same reason, same
 *  order of magnitude as the conversation mode. */
export const DICTEE_RESTART_DELAY_MS = 250;

/**
 * Errors on which restarting is pointless: the microphone is refused or taken
 * by another application. Without this filter, the grace window would loop on
 * `start()` every 250 ms until it expires.
 *
 * `network` is one too (TIM-0061): where the recognition service cannot be
 * reached — always the case in the desktop app — every relaunch fails the same
 * way, and the button stayed on "Listening…" while nothing was transcribed.
 *
 * `no-speech` and `aborted` are NOT: they are the ordinary turn ends of a
 * listening session that just went through a pause.
 */
export function erreurDicteeFatale(error: string): boolean {
  return (
    error === 'not-allowed' ||
    error === 'audio-capture' ||
    error === 'service-not-allowed' ||
    error === 'network' ||
    // The desktop's local engine (lib/dictation): every one of its failures is terminal.
    isLocalDictationError(error)
  );
}

/**
 * True in the Timon desktop app (Electron). Electron exposes Chromium's Web
 * Speech API but not the speech service behind it: the constructor exists,
 * the mic opens, and the first `start()` ends on `network` (TIM-0061). Both
 * signals are checked: the preload bridge is ours, the user agent token also
 * covers a window where the bridge failed to load.
 */
export function webSpeechSansMoteur(env: { userAgent: string; desktopBridge: boolean }): boolean {
  return env.desktopBridge || /\bElectron\//.test(env.userAgent);
}

export type EtatFinDictee = {
  /** The user asked to stop (microphone button, unmount, silence expired). */
  arretManuel: boolean;
  /** A fatal error was received during the session. */
  erreurFatale: boolean;
  /** Milliseconds since the last recognised speech (or since the start when
   *  nothing has been said yet). */
  depuisDerniereActivite: number;
  graceMs?: number;
};

/** True when `onend` must restart listening instead of closing dictation. */
export function doitRelancerDictee(etat: EtatFinDictee): boolean {
  if (etat.arretManuel || etat.erreurFatale) return false;
  return etat.depuisDerniereActivite < (etat.graceMs ?? DICTEE_GRACE_MS);
}

/**
 * Folds the text of one session into the dictation's base.
 *
 * Each restart starts again from an EMPTY `event.results`: without this fold,
 * the first `onresult` of the new session would rewrite the field with only
 * the sentence just spoken, erasing everything before it.
 */
export function composerDictee(base: string, texte: string): string {
  const gauche = base ?? '';
  const droite = (texte ?? '').trim();
  if (!droite) return gauche;
  if (!gauche) return droite;
  return `${gauche}${gauche.endsWith(' ') ? '' : ' '}${droite}`;
}

/** A result of the Web Speech engine, reduced to what the composition needs. */
export type ResultatDictee = {
  isFinal: boolean;
  transcript: string;
};

/**
 * Composes the text of ONE recognition session from the whole of
 * `event.results`.
 *
 * The trap this function exists to close: in continuous listening, a session
 * accumulates several results, and `event.resultIndex` moves to the only
 * segment that just changed. Composing from `resultIndex` therefore returns
 * only the last sentence — the field lost everything dictated since the start
 * of the session as soon as the speaker paused.
 *
 * It always starts again from index 0: finalised segments stay in place in the
 * array, the current interim fills the last slot and is replaced — by the
 * array itself — on every event.
 *
 * But index 0 is not enough: several Android engines re-emit the WHOLE
 * sentence on every event, each copy in its own slot ("hi / hi how / hi how
 * are"). Joining them as they are gives "hi hi how hi how are": the slots
 * therefore go through `fusionnerSegments`, which replaces a segment that
 * extends what precedes instead of appending it (see lib/stt-transcript).
 */
export function texteSession(results: ArrayLike<ResultatDictee>): string {
  const segments: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    segments.push(results[i]?.transcript ?? '');
  }
  return fusionnerSegments(segments);
}
