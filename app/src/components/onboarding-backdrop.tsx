'use client';

/**
 * Shared first-run / login stage: atmospheric grid, brand-forward, no card hero.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SetupSteps, type SetupStep } from '@/components/setup-steps';

export function OnboardingBackdrop(
  { children, className, center = false, step }: { children: ReactNode; className?: string; center?: boolean; step?: SetupStep },
) {
  return (
    <div className={cn('rooks-stage relative flex min-h-screen w-full flex-col overflow-auto px-4 py-10', step && 'pt-16')}>
      <div aria-hidden className="rooks-stage-grid pointer-events-none absolute inset-0" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 50% 40% at 12% 18%, hsl(var(--primary) / 0.12), transparent 70%), radial-gradient(ellipse 40% 35% at 88% 82%, hsl(210 30% 45% / 0.08), transparent 65%)',
        }}
      />
      {step && <SetupSteps current={step} className="absolute inset-x-0 top-3 z-[1] flex justify-center px-4" />}
      <div className="relative flex w-full flex-1 justify-center">
        <div className={cn('w-full', center && 'my-auto', className)}>{children}</div>
      </div>
    </div>
  );
}
