'use client';

/**
 * 16:9 well at the top of the plugin sheet. Cover first, then `screenshots`.
 * Arrows and dots only when there is more than one still. Reduced-motion
 * skips the slide; the index still changes.
 */
import { useEffect, useState } from 'react';
import { Blocks, ChevronLeft, ChevronRight } from 'lucide-react';
import { Picto } from '@/components/picto';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function PluginMediaCarousel({ slides, iconUrl = null }: { slides: readonly string[]; iconUrl?: string | null }): React.ReactElement {
  const [index, setIndex] = useState(0);
  const [reduce, setReduce] = useState(false);

  useEffect(() => { setIndex(0); }, [slides.join('\0')]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = (): void => setReduce(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const count = slides.length;
  const go = (delta: number): void => {
    if (count < 2) return;
    setIndex((i) => (i + delta + count) % count);
  };

  return (
    <div
      className="relative flex aspect-[16/9] items-center justify-center overflow-hidden bg-muted/40"
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      }}
      tabIndex={count > 1 ? 0 : undefined}
      role="region"
      aria-roledescription="carousel"
      aria-label={t('pluginsPage.gallery')}
    >
      {count === 0 && iconUrl ? (
        <Picto icon={iconUrl} className="size-16 text-foreground/70" />
      ) : count === 0 ? (
        <div className="flex flex-col items-center gap-2 text-muted-foreground/60">
          <Blocks className="h-10 w-10" aria-hidden />
          <span className="text-[11px] uppercase tracking-[0.18em]">{t('pluginsPage.noPreview')}</span>
        </div>
      ) : (
        <div
          className={cn('flex h-full w-full', !reduce && 'transition-transform duration-300 ease-out motion-reduce:transition-none')}
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {slides.map((src) => (
            // Plugin-supplied still: next/image would push a local file through its optimiser.
            // eslint-disable-next-line @next/next/no-img-element
            <img key={src} src={src} alt="" className="h-full w-full shrink-0 object-cover" />
          ))}
        </div>
      )}

      {count > 1 && (
        <>
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label={t('pluginsPage.prevSlide')}
            className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-background/70 text-foreground shadow-sm hover:bg-background"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label={t('pluginsPage.nextSlide')}
            className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-background/70 text-foreground shadow-sm hover:bg-background"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
          <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5" aria-hidden>
            {slides.map((src, i) => (
              <button
                key={src}
                type="button"
                onClick={() => setIndex(i)}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  i === index ? 'w-4 bg-foreground' : 'w-1.5 bg-foreground/40',
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
