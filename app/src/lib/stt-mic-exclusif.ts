/**
 * Microphone exclusivity conflict on Android (Chromium bug 41083534).
 *
 * Opening a second `getUserMedia` stream — the audio visualiser's — while
 * `SpeechRecognition` listens makes the system engine lose the microphone:
 * recognition stops on `aborted` without ever transcribing anything. The
 * symptom is perfectly silent: the phone's microphone icon stays on (the
 * visualiser holds it), the UI shows "listening", and no text ever arrives.
 *
 * No up-front detection is reliable (the conflict depends on the installed
 * STT engine, not on a user agent): the first failure is learned from and the
 * lesson is kept for this device. The visualiser is a nicety, dictation is
 * the feature — on a conflict, the visualiser goes.
 */

const CLE = 'timon.stt.mic-exclusif';

/**
 * Android does not always report the conflict: rather than an error, the
 * recognition engine gets a *silent* stream while the visualiser picks up the
 * voice perfectly. The log of 24/08 leaves no doubt — visualiser open:
 * `onstart`, `onaudiostart`, then nothing, never an `onspeechstart`, no
 * error; visualiser off: full transcription.
 *
 * No live detection is therefore possible: there is nothing to detect but
 * silence. On mobile, the visualiser does not open while listening — dictation
 * is the feature, the audio level is only an ornament.
 *
 * The exclusivity does not stop at the microphone: every `start()` of the
 * recognition also claims the system's audio focus, which interrupts the
 * current playback. Continuous listening while the agent spoke therefore
 * chopped its voice every five seconds, at the pace of the restarts.
 */
export function microExclusif(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (typeof ua.userAgentData?.mobile === 'boolean') return ua.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** True when the second microphone stream is banned on this device: a
 *  platform with an exclusive microphone, or a conflict already seen here. */
export function visualiseurInterdit(): boolean {
  if (typeof window === 'undefined') return false;
  if (microExclusif()) return true;
  try {
    return window.localStorage.getItem(CLE) === '1';
  } catch {
    return false;
  }
}

export function interdireVisualiseur(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CLE, '1');
  } catch {
    // Private browsing: the lesson holds for the current session only,
    // through the caller's in-memory state.
  }
}

/** Error codes consistent with a stolen microphone. `aborted` also covers a
 *  deliberate stop: the caller must check that no result was received and no
 *  manual stop is under way before concluding to a conflict. */
export function estConflitMicro(error: string): boolean {
  return error === 'aborted' || error === 'audio-capture';
}
