'use client';

import { cn } from '@/lib/utils';
import { LiveAgentMascot } from '@/components/mascot/live-agent-mascot';
import type { Visage } from './use-agents';

/**
 * The frame classes a caller puts around `FaceAgent` (round clip, border,
 * fill), or nothing for a mascot: a mascot is its own frame, and a circle
 * around it read as one more ring (and clipped its ears).
 */
export function faceFrame(visage: Visage, frame: string): string | undefined {
  return visage.look ? undefined : frame;
}

/** The inside of a round avatar: the image, or the glyph in its colour. The
 *  frame (size, border, ring) is the caller's — the row and the picker do not
 *  draw it the same way; `faceFrame` drops it for a mascot. */
export function FaceAgent({ visage, className, agent, live = true }: {
  visage: Visage;
  className?: string;
  /** The agent the face stands for: its mascot then shows what it does. Absent: the bare look. */
  agent?: string;
  /** `false`: the bare look, still — pickers and menus. */
  live?: boolean;
}) {
  if (visage.look) {
    // Scaled to the caller's frame: the mascot's own box is a fixed size in pixels.
    return (
      <span aria-hidden className="grid size-full place-items-center [&_svg]:size-full" data-agent-mascot>
        <LiveAgentMascot name={agent ?? ''} look={visage.look} size={32} live={live && !!agent} className="size-full" />
      </span>
    );
  }
  if (visage.image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={visage.image} alt="" className="size-full object-cover" />;
  }
  return (
    <span aria-hidden className={cn('font-semibold uppercase leading-none', className)} style={{ color: visage.couleur }}>
      {visage.glyphe}
    </span>
  );
}

/** `FaceAgent` in the round bordered frame of a list row, dropped for a mascot (`faceFrame`). */
export function FramedFace({ visage, className, glyphClassName }: {
  visage: Visage;
  /** Size of the frame, e.g. `size-6`. */
  className?: string;
  glyphClassName?: string;
}) {
  return (
    <span className={cn('grid shrink-0 place-items-center', className, faceFrame(visage, 'overflow-hidden rounded-full border border-border bg-card'))}>
      <FaceAgent visage={visage} className={glyphClassName} />
    </span>
  );
}
