'use client';

/**
 * The backdrop the first-run screens share (login, then `/setup`).
 *
 * Extracted from `LoginShell` because the two steps must not look like two
 * products: the account form used its own opaque canvas while `/setup`
 * inherited the global hexagon pattern of `#timon-background`, so the wizard
 * changed skin between step 1 and step 2.
 *
 * `bg-background` is what does the work — it is opaque, so it hides the
 * per-account backdrop portal underneath. The pattern is untouched everywhere
 * else in the product; only these screens opt out of it.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SetupSteps, type SetupStep } from '@/components/setup-steps';

/**
 * `step`: the wizard's progress, drawn ONCE, at the top of the page and outside
 * the content column — never inside a card, where a narrow form would wrap it.
 */
export function OnboardingBackdrop(
  { children, className, center = false, step }: { children: ReactNode; className?: string; center?: boolean; step?: SetupStep },
) {
  return (
    <div className={cn('relative flex min-h-screen w-full flex-col overflow-auto bg-background px-4 py-10', step && 'pt-16')}>
      {/* Salmon halo — the brand colour, kept faint so the form stays the only
          thing with contrast. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 55% 45% at 50% 15%, hsl(var(--primary) / 0.10), transparent 70%)',
        }}
      />
      {/* Secondary: pinned to the top edge, out of the flow, so the content
          below centres on the whole screen rather than under it. */}
      {step && <SetupSteps current={step} className="absolute inset-x-0 top-3 z-[1] flex justify-center px-4" />}
      <div className="relative flex w-full flex-1 justify-center">
        {/* Auto margins, not `items-center`: they centre a card that fits and
            collapse to zero on a form taller than the screen, which then starts
            at the top instead of overflowing above it, out of scroll reach. */}
        <div className={cn('w-full', center && 'my-auto', className)}>{children}</div>
      </div>
    </div>
  );
}
