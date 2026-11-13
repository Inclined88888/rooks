'use client';

import { useEffect, useState } from 'react';
import { VoiceSphereInline } from '@/components/cockpit/voice-sphere-inline';
import type { VoiceSphereState } from '@/components/cockpit/voice-sphere';
import type { LiveTurns } from '@/lib/gpt-live/use-gpt-live';
import { cn } from '@/lib/utils';

type Streams = { mic: MediaStream | null; remote: MediaStream | null };

/** One level meter per stream, on a single AudioContext closed with the
 *  session: an open context keeps the audio device busy after the call. */
function useAnalysers(streams: Streams): { mic: AnalyserNode | null; remote: AnalyserNode | null } {
  const [nodes, setNodes] = useState<{ mic: AnalyserNode | null; remote: AnalyserNode | null }>({ mic: null, remote: null });
  useEffect(() => {
    if (!streams.mic && !streams.remote) return;
    if (typeof window === 'undefined' || !window.AudioContext) return;
    const ctx = new AudioContext();
    void ctx.resume().catch(() => { /* a suspended context only flattens the sphere */ });
    const meter = (stream: MediaStream | null): AnalyserNode | null => {
      if (!stream || stream.getAudioTracks().length === 0) return null;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;
      // Measured only, never routed to the speakers: the <audio> element
      // already plays GPT-Live, a second path would echo.
      ctx.createMediaStreamSource(stream).connect(analyser);
      return analyser;
    };
    setNodes({ mic: meter(streams.mic), remote: meter(streams.remote) });
    return () => {
      setNodes({ mic: null, remote: null });
      void ctx.close().catch(() => { /* already closed */ });
    };
  }, [streams.mic, streams.remote]);
  return nodes;
}

/**
 * Live mode of the chat while a GPT-Live session runs: the voice sphere alone,
 * laid over the composer. Its anchor has no height, so the thread and the bars
 * above the input do not move when the session starts or stops; the
 * composer's GPT-Live button carries the state and ends the session.
 */
export function GptLiveStage({ turns, streams, waiting, compact }: {
  turns: LiveTurns;
  streams: Streams;
  /** A delegated request is still with the agent. */
  waiting: boolean;
  compact?: boolean;
}) {
  const analysers = useAnalysers(streams);
  const sphere: VoiceSphereState = turns.speaking ? 'speaking' : waiting ? 'thinking' : 'listening';

  return (
    // `z-20` lifts the sphere ABOVE the composer (`z-10`): laid behind a
    // blurred card it read as a shapeless halo. It takes no pointer event, so
    // the input and its buttons stay clickable through it.
    <div
      className={cn(
        'pointer-events-none relative z-20 mx-auto h-0 w-full',
        compact ? 'max-w-full' : 'max-w-3xl',
      )}
    >
      {/* This anchor sits on the composer's top edge: a quarter of the sphere
          rises above it, the rest covers the composer. */}
      <VoiceSphereInline
        state={sphere}
        analyser={sphere === 'speaking' ? analysers.remote : analysers.mic}
        className={cn(
          'absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/4',
          compact ? 'size-40' : 'size-56',
        )}
      />
    </div>
  );
}
