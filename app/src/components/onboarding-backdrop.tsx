'use client';

/**
 * Shared first-run / login stage: quiet shell, brand-forward, no card hero,
 * no decorative grid or glow.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SetupSteps, type SetupStep } from '@/components/setup-steps';

export function OnboardingBackdrop(
  { children, className, center = false, step }: { children: ReactNode; className?: string; center?: boolean; step?: SetupStep },
) {
  return (
    <div className={cn('rooks-stage relative flex min-h-screen w-full flex-col overflow-auto px-4 py-10', step && 'pt-16')}>
      {step && <SetupSteps current={step} className="absolute inset-x-0 top-3 z-[1] flex justify-center px-4" />}
      <div className="relative flex w-full flex-1 justify-center">
        <div className={cn('w-full', center && 'my-auto', className)}>{children}</div>
      </div>
    </div>
  );
}
