'use client';

import { lazy, Suspense, type ReactElement } from 'react';
import { toast } from 'sonner';

import { LocalModelConsentCard } from './local-dictation/consent-card';
import { createLocalDictationEngine, LOCAL_ENGINE_ID } from './local-dictation/engine';
import { localEngine } from './local-dictation/local-engine';
import type { BundledClientPlugin } from './types';

const CONSENT_TOAST_ID = 'local-dictation-consent';

/**
 * Local dictation of the desktop app (TODO #443), an occupant of the
 * dictation contract like any engine (TODO #484 §3.5): it registers the
 * desktop's sherpa engine in `dictation.engine`, holding `dictation:engine`
 * like a third-party one, and the product reaches it only through that
 * registration. Its code imports nothing of `app/src/lib` but the contract's
 * types and `@rooks/ui` (`local-dictation-imports.test.ts`): the desktop
 * bridge is the one thing it has that a third party has not.
 *
 * The component registered with the engine is the speech model's pane:
 * Settings → Interface → Voice dictation paints it under the engine's card
 * (TODO #492). A start without a model is answered with the consent card. The
 * card goes through the app's single toaster rather than the `overlay` slot:
 * `/chat`, `/agents` and `/multichat` render without `AppFrame`, which is
 * what paints `overlay`, and the composer's microphone lives there. Nothing
 * is registered outside the desktop app — a browser has no model to manage.
 * The settings dialog itself hides from a viewer without `/settings`.
 */
// The model pane (catalog, import, per-language choice) is painted only in
// Settings: fetched there, not with the root layout (docs/BUNDLE-SIZE.md).
// `React.lazy`, not `next/dynamic`: this occupant imports what a third party
// could (`local-dictation-imports.test.ts`).
const LazyLocalDictationSettings = lazy(() => import('./local-dictation/local-dictation-settings')
  .then((m) => ({ default: m.LocalDictationSettings })));

function LocalDictationSettings(): ReactElement {
  return <Suspense fallback={null}><LazyLocalDictationSettings /></Suspense>;
}

export const localDictationClient: BundledClientPlugin = {
  module: '@rooks/settings',
  permissions: ['dictation:engine'],
  apply(ctx) {
    const store = localEngine();
    if (!store) return;
    const close = () => { toast.dismiss(CONSENT_TOAST_ID); };
    ctx.onDispose(store.presentConsentWith(() => {
      toast.custom(() => <LocalModelConsentCard onClose={close} />, {
        id: CONSENT_TOAST_ID,
        duration: Number.POSITIVE_INFINITY,
        unstyled: true,
      });
    }));
    ctx.onDispose(close);
    ctx.register(
      { slot: 'dictation.engine', key: LOCAL_ENGINE_ID, dictation: createLocalDictationEngine(store) },
      LocalDictationSettings,
    );
  },
};
