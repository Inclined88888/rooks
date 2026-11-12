'use client';

import type { CSSProperties } from 'react';
import { pictoSrc } from '@/lib/picto';
import { cn } from '@/lib/utils';

/**
 * A plugin or widget picto, painted as a mask filled with the current text
 * colour: only the shape of the SVG counts, so it follows light/dark and the
 * accent without the author knowing the theme. An `<img>` could not —
 * `currentColor` inside an image document is always black.
 */
export function Picto({ icon, className }: { icon: string; className?: string }): React.ReactElement {
  const url = `url("${pictoSrc(icon).replace(/"/g, '%22')}")`;
  const style: CSSProperties = {
    maskImage: url,
    WebkitMaskImage: url,
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskPosition: 'center',
    maskSize: 'contain',
    WebkitMaskSize: 'contain',
  };
  return <span aria-hidden className={cn('inline-block shrink-0 bg-current', className)} style={style} />;
}
