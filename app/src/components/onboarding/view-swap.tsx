'use client';

/**
 * One block that changes in place: the old content fades out, the new one is
 * painted, then the box grows or shrinks from the old height to the new one
 * while it fades in. The rest of the screen does not move — what the mockup's
 * "Choose your LLM" does when a choice opens its block.
 *
 * Under reduced motion, or without the Web Animations API (jsdom), the
 * content changes at once.
 */
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { usePrefersReducedMotion } from '@/components/mascot/agent-mascot';
import { cn } from '@/lib/utils';

const OUT_MS = 130;
const IN_MS = 260;

export type ViewSwapProps<V extends string> = {
  view: V;
  render: (view: V) => ReactNode;
  className?: string;
};

export function ViewSwap<V extends string>({ view, render, className }: ViewSwapProps<V>): ReactElement {
  const [shown, setShown] = useState<V>(view);
  const box = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (view === shown) return;
    const el = box.current;
    if (reduced || !el || typeof el.animate !== 'function') {
      setShown(view);
      return;
    }
    let live = true;
    const from = el.offsetHeight;
    const out = el.animate(
      [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px)' }],
      { duration: OUT_MS, easing: 'ease-in', fill: 'forwards' },
    );
    out.onfinish = () => {
      if (!live) return;
      // Painted now, measured right after: the height animation needs the new block's size.
      flushSync(() => setShown(view));
      out.cancel();
      const to = el.offsetHeight;
      el.animate(
        [
          { opacity: 0, transform: 'translateY(10px)', height: `${from}px` },
          { opacity: 1, transform: 'none', height: `${to}px` },
        ],
        { duration: IN_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    };
    return () => {
      // A second choice during the fade: the next swap starts from a visible block.
      live = false;
      out.cancel();
    };
  }, [view, shown, reduced]);

  return (
    <div ref={box} data-view={shown} className={cn('overflow-hidden', className)}>
      {render(shown)}
    </div>
  );
}
