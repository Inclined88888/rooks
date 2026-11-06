'use client';

import dynamic from 'next/dynamic';

import { cn } from '@/lib/utils';
import type { VoiceSphereState } from './voice-sphere';

// three.js touches `window` at import time: never on the server.
const VoiceSphere = dynamic(() => import('./voice-sphere'), { ssr: false });

/** The voice sphere as a square laid over the input, shared by the cockpit's
 *  voice mode and the chat's GPT-Live mode. The caller sizes and positions it;
 *  the thread above stays fully visible, which a full-viewport backdrop did not
 *  allow. The radial mask fades the dust and the bloom out before the canvas
 *  edge, so the box never shows a hard square cut. It paints IN FRONT of the
 *  input, slightly translucent (0.85) so the placeholder, the typed text and
 *  the buttons stay readable through it, and never takes a pointer event: they
 *  stay clickable underneath. */
export function VoiceSphereInline({ state, analyser, className }: {
  state: VoiceSphereState;
  analyser: AnalyserNode | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'pointer-events-none shrink-0 opacity-[0.85] [mask-image:radial-gradient(closest-side,black_72%,transparent)]',
        className,
      )}
      aria-hidden
    >
      <VoiceSphere state={state} analyser={analyser} />
    </div>
  );
}
