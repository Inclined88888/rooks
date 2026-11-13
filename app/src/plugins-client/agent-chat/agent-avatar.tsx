'use client';

import { cn } from '@/lib/utils';
import type { Visage } from './use-agents';

/** A face sits in the caller's disc. A stored mascot is not a frame of its own. */
export function faceFrame(_visage: Visage, frame: string): string | undefined {
  return frame;
}

/** The inside of a round avatar: the image, or the glyph in its colour. The
 *  frame (size, border, ring) is the caller's — the row and the picker do not
 *  draw it the same way; `faceFrame` drops it for a mascot. */
export function FaceAgent({ visage, className, agent }: {
  visage: Visage;
  className?: string;
  /** The agent the face stands for: its mascot then shows what it does. Absent: the bare look. */
  agent?: string;
  /** `false`: the bare look, still — pickers and menus. */
  live?: boolean;
}) {
  if (visage.image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={visage.image} alt="" className="size-full object-cover" />;
  }
  return (
    <span aria-hidden className={cn('font-semibold uppercase leading-none', className)} style={{ color: visage.couleur }}>
      {faceLetter(visage.glyphe, agent)}
    </span>
  );
}

function faceLetter(glyphe: string, agent?: string): string {
  const one = [...glyphe.trim()][0] ?? '';
  if ([...glyphe.trim()].length === 1 && /^[\p{L}\p{N}]$/u.test(one)) return one;
  const fromName = [...(agent ?? '').trim()][0];
  return fromName && /^[\p{L}\p{N}]$/u.test(fromName) ? fromName : '?';
}

/** `FaceAgent` in the round bordered frame of a list row. */
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
