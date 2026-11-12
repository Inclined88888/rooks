import { getLocale, t } from '@rooks/ui';

import type {
  DictationAvailability, DictationEngine, DictationErrorCode, DictationEvent, DictationSession, DictationStartOptions,
} from '@/lib/dictation/contract';
import type { EngineErrorCode, SpeechBridge, SpeechEvent } from './desktop-speech';
import type { LocalEngineStore } from './local-engine';
import { activeModel, chosenModel, effectiveLanguage } from './model-view';
import { voiceSettings, type VoiceSettings } from './voice-settings';

/**
 * The desktop's sherpa engine behind the public dictation contract
 * (`DictationEngine`, client API 14, TODO #484 §3.5). Nothing here is
 * privileged: the product hands this engine the same calls, the same PCM and
 * the same checks as a third-party one. What only it has is the desktop
 * bridge, `window.rooksDesktop.speech` — an internal API of the product, not
 * a public surface (a third party brings model packs, or its own engine).
 *
 * The bridge speaks in sessions it numbers itself; this adapter keeps that
 * number to itself and hands the product events without it.
 */

export const LOCAL_ENGINE_ID = 'local';

type Store = Pick<LocalEngineStore, 'snapshot' | 'refresh' | 'hasReadyModel' | 'models' | 'onSession' | 'requestConsent' | 'noteStarted'> & {
  bridge: SpeechBridge;
};

const ERROR_CODES: Record<EngineErrorCode, DictationErrorCode> = {
  'engine-unavailable': 'unavailable',
  'model-missing': 'needs-setup',
  'init-failed': 'crashed',
  'engine-crashed': 'crashed',
  'decode-failed': 'decode-failed',
  busy: 'busy',
};

/** Thrown by `start` after its `error` and `stopped` events: the product already read why. */
class LocalStartError extends Error {}

/**
 * `settings`: the pane's choices (`voice-settings.ts`), read at each start —
 * the user's language wins over the surface's, which is only the default.
 */
export function createLocalDictationEngine(store: Store, settings: () => VoiceSettings = voiceSettings): DictationEngine {
  /** The language a dictation runs in, `fallback` being the surface's (the UI's). */
  function languageFor(fallback: string | null): string {
    return effectiveLanguage(settings().language, fallback, store.models());
  }

  /**
   * The model is missing: the consent card is this engine's own setup, and a
   * start is the user asking to dictate, so it opens here. An empty message
   * tells the product the card already says it.
   */
  function needsSetup(): { code: DictationErrorCode; message: string } {
    return { code: 'needs-setup', message: store.requestConsent() ? '' : 'Download the speech model first.' };
  }

  /** Whether an installed model fits `lang`; with no catalog (an older desktop), whether any model is installed. */
  function readyFor(lang: string): boolean | null {
    const listing = store.models();
    if (!listing || store.hasReadyModel() === null) return store.hasReadyModel();
    return activeModel(lang, settings(), listing) !== null;
  }

  async function knownReady(lang: () => string): Promise<boolean | null> {
    const ready = readyFor(lang());
    if (ready !== null) return ready;
    await store.refresh();
    return readyFor(lang());
  }

  return {
    id: LOCAL_ENGINE_ID,
    get label() { return t('dictation.localEngine.label'); },
    /** The desktop picks the model that fits the language, and detects it when none fits. */
    get languages() {
      const codes = new Set((store.models() ?? []).flatMap((entry) => entry.languages.codes));
      return { codes: [...codes].sort(), mode: 'auto' as const };
    },
    interim: 'live',

    async availability(): Promise<DictationAvailability> {
      const state = store.snapshot() ?? await store.refresh();
      // Unknown is not "unavailable": the product treats a failed answer as unknown.
      if (!state) throw new Error('The desktop did not answer.');
      if (state.engine !== 'available') return { state: 'unavailable', reason: state.engine };
      return readyFor(languageFor(getLocale())) ? { state: 'ready' } : { state: 'needs-setup' };
    },

    async start({ language, signal, onEvent }: DictationStartOptions): Promise<DictationSession> {
      const failure = (error: { code: DictationErrorCode; message: string }): LocalStartError => {
        onEvent({ type: 'error', code: error.code, message: error.message, fatal: true });
        onEvent({ type: 'stopped' });
        return new LocalStartError(error.message || error.code);
      };
      // Known missing: the card, without the desktop loading anything.
      if ((await knownReady(() => languageFor(language))) === false) throw failure(needsSetup());
      const lang = languageFor(language);
      const { interim } = settings();
      const listing = store.models();
      const chosen = listing ? chosenModel(lang, settings(), listing) : undefined;

      let sessionId: string | null = null;
      let ended = false;
      let stopRequested = false;
      let failed = false;
      const pending: Array<Exclude<SpeechEvent, { type: 'model-state' }>> = [];
      const forward = (event: Exclude<SpeechEvent, { type: 'model-state' }>): void => {
        if (ended || event.sessionId !== sessionId) return;
        const out: DictationEvent[] = [];
        switch (event.type) {
          case 'partial':
          case 'final':
            out.push({ type: event.type, text: event.text });
            break;
          case 'error': {
            const fatal = event.code !== 'decode-failed';
            if (fatal) failed = true;
            out.push({ type: 'error', code: ERROR_CODES[event.code], message: event.message, fatal });
            break;
          }
          case 'stopped':
            // Ended without anyone asking: another surface opened its own session.
            if (!stopRequested && !failed) out.push({ type: 'error', code: 'busy', message: '', fatal: true });
            out.push({ type: 'stopped' });
            ended = true;
            unsubscribe();
            break;
        }
        for (const item of out) onEvent(item);
      };
      // Subscribed before the start: an event may land before its answer does.
      const unsubscribe = store.onSession((event) => {
        if (sessionId === null) pending.push(event);
        else forward(event);
      });

      const started = await store.bridge.startDictation({
        language: lang,
        // Unset, the desktop picks the model that fits; a model it cannot use falls back the same way.
        ...(chosen ? { modelId: chosen.id } : {}),
        ...(interim !== 'auto' ? { interim } : {}),
      }).catch(() => ({ ok: false as const, code: 'init-failed' as const, message: '' }));
      if (!started.ok) {
        unsubscribe();
        throw failure(started.code === 'model-missing' ? needsSetup() : { code: ERROR_CODES[started.code], message: started.message });
      }
      const id = started.sessionId;
      if (started.session) store.noteStarted(started.session);
      if (signal.aborted) {
        unsubscribe();
        void store.bridge.cancelDictation(id).catch(() => {});
        throw new LocalStartError('aborted');
      }
      sessionId = id;
      for (const event of pending.splice(0)) forward(event);

      const cancel = (): void => {
        if (ended) return;
        stopRequested = true;
        ended = true;
        unsubscribe();
        void store.bridge.cancelDictation(id).catch(() => {});
      };
      signal.addEventListener('abort', cancel, { once: true });
      return {
        feed(pcm) {
          if (!ended && !stopRequested) store.bridge.feed(id, pcm);
        },
        async stop() {
          if (ended) return;
          stopRequested = true;
          // Resolves after the session's last final; `stopped` normally lands first.
          await store.bridge.stopDictation(id).catch(() => {});
        },
        cancel,
      };
    },
  };
}
