'use client';

/**
 * The composer's image thumbnails (TIM-0125). Up to three they sit in a row;
 * past that they fold into a fanned stack with a count, so ten photos do not
 * push the text field off screen. A click unfolds the stack — every thumbnail
 * keeps its remove button — and a second click, a click outside or Escape
 * folds it back.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronsLeft, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { fmtAttachmentSize } from '@/lib/attachments';
import { t as i18n } from '@/lib/i18n';
import type { PendingImage } from './chat-types';

/** Above this many images, the row folds into a stack. */
export const IMAGE_STACK_THRESHOLD = 3;

/** Offset and tilt of the top three cards of a folded stack. */
const FAN = [
  { left: 0, rotate: -6 },
  { left: 8, rotate: 0 },
  { left: 16, rotate: 6 },
] as const;

export function PendingImageStack({
  images,
  onRemove,
}: {
  images: readonly PendingImage[];
  onRemove: (image: PendingImage) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const stacked = images.length > IMAGE_STACK_THRESHOLD;

  // Back to three or fewer: the next time it grows, it starts folded.
  useEffect(() => {
    if (!stacked) setOpen(false);
  }, [stacked]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: Event) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setOpen(false);
    };
    // Capture: a canvas or a drag handler that stops propagation must not
    // keep the stack open (the TIM-0123 lesson).
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (images.length === 0) return null;
  const label = i18n('chatPage.imageStack', { count: String(images.length) });

  if (stacked && !open) {
    const top = images.slice(-FAN.length);
    return (
      <div ref={boxRef} className="mx-1.5 mb-1.5 flex">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-label={label}
          title={label}
          className="relative h-16 w-[5.25rem] shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {top.map((image, index) => {
            const fan = FAN[index + FAN.length - top.length] ?? FAN[0];
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={image.id}
                src={image.previewUrl}
                alt=""
                className="absolute top-1 size-14 rounded-md border border-border bg-muted/30 object-cover shadow-sm"
                style={{ left: fan.left, transform: `rotate(${fan.rotate}deg)` }}
              />
            );
          })}
          <span
            data-testid="image-stack-count"
            className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10.5px] font-medium tabular-nums text-primary-foreground"
          >
            {images.length}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="mx-1.5 mb-1.5 flex flex-wrap gap-1.5">
      {stacked && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-expanded
          aria-label={label}
          title={label}
          className="grid h-16 w-8 shrink-0 place-items-center rounded-md bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronsLeft className="size-4" />
        </button>
      )}
      {images.map((image) => (
        <div
          key={image.id}
          className="group relative h-16 w-16 overflow-hidden rounded-md border border-border bg-muted/30"
          title={`${image.mediaType} · ${fmtAttachmentSize(image.size)}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.previewUrl}
            alt={i18n('chatPage.pendingImageAlt')}
            className="h-full w-full object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(image)}
            className={cn(
              'absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-black/70 text-white',
              'opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100',
            )}
            aria-label={i18n('chatPage.removeAttachment')}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
