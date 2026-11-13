'use client';

import { cn } from '@/lib/utils';
import { BrandLogo } from '@/components/brand-logo';

/**
 * Rooks lockup: tower mark + custom wordmark. Hero-level brand signal —
 * the wordmark uses the display face, not a generic system stack.
 */
export function BrandWordmark({
  className,
  markClassName = 'h-9',
  wordClassName,
  compact = false,
}: {
  className?: string;
  markClassName?: string;
  wordClassName?: string;
  /** Mark only beside a small label (nav). */
  compact?: boolean;
}) {
  return (
    <div className={cn('inline-flex items-center gap-3', className)}>
      <BrandLogo className={markClassName} alt="" />
      <span
        className={cn(
          'font-[family-name:var(--font-display)] font-semibold tracking-[-0.04em] text-foreground',
          compact ? 'text-sm' : 'text-[clamp(1.75rem,4vw,2.75rem)] leading-none',
          wordClassName,
        )}
        aria-label="Rooks"
      >
        Rooks
      </span>
    </div>
  );
}
