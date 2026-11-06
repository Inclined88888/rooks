'use client';

/**
 * The welcome screen's language picker: a 3D roller of the languages present
 * in `app/src/locales/`, each in its own name. Wheel, drag, arrows or a click
 * on a row turn it; the row in the middle is the language, applied once the
 * roller rests on it a moment or stops there (`onChange`, `languageDwell`), so
 * a drag across the list does not load every language it crosses. Enter
 * confirms (`onConfirm`). Each row shows its flag (`language-flags.tsx`).
 *
 * Positions are written straight to the rows' style from an animation frame:
 * a spring at sixty frames a second would re-render the screen sixty times.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { LocaleInfo } from '@/lib/i18n';
import { t } from '@/lib/i18n';
import { usePrefersReducedMotion } from '@/components/mascot/agent-mascot';
import { LanguageFlag } from './language-flags';
import { languageDwell, type LanguageDwell } from './language';

const ROW = 44;

type Props = {
  languages: readonly LocaleInfo[];
  value: string;
  onChange: (tag: string) => void;
  onConfirm: () => void;
  label: string;
  className?: string;
};

export function LanguageRoller({ languages, value, onChange, onConfirm, label, className }: Props): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const start = Math.max(0, languages.findIndex((info) => info.tag === value));
  const pos = useRef(start);
  const target = useRef(start);
  const vel = useRef(0);
  const shown = useRef(start);
  const drag = useRef<{ y: number; p: number; moved: boolean } | null>(null);
  const raf = useRef(0);
  const [selected, setSelected] = useState(start);
  const reduced = usePrefersReducedMotion();
  const latest = useRef({ languages, onChange, reduced });
  latest.current = { languages, onChange, reduced };
  const dwell = useRef<LanguageDwell | null>(null);
  dwell.current ??= languageDwell(value, (tag) => latest.current.onChange(tag));

  const last = languages.length - 1;
  const clamp = useCallback((x: number): number => Math.max(0, Math.min(latest.current.languages.length - 1, x)), []);

  const paint = useCallback((): void => {
    rows.current.forEach((el, i) => {
      if (!el) return;
      const d = i - pos.current;
      const ad = Math.abs(d);
      el.style.transform = `translateY(${d * ROW * 0.92}px) rotateX(${-d * 20}deg) scale(${1 - Math.min(ad, 3) * 0.07})`;
      el.style.opacity = ad > 2.6 ? '0' : (1 - ad * 0.36).toFixed(3);
      el.style.color = ad < 0.5 ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))';
      el.style.fontSize = ad < 0.5 ? '21px' : '18px';
    });
  }, []);

  /** The row in the middle changed: that is the language now, once the roller rests on it. */
  const settle = useCallback((): void => {
    const idx = Math.round(pos.current);
    if (idx === shown.current) return;
    shown.current = idx;
    setSelected(idx);
    const info = latest.current.languages[idx];
    if (info) dwell.current?.cross(info.tag);
  }, []);

  /** The roller stopped: its language applies now. */
  const rest = useCallback((): void => {
    const info = latest.current.languages[shown.current];
    if (info) dwell.current?.rest(info.tag);
  }, []);

  const loop = useCallback((): void => {
    if (drag.current === null) {
      const f = (target.current - pos.current) * 0.16;
      vel.current = vel.current * 0.6 + f;
      pos.current += vel.current;
      if (latest.current.reduced || (Math.abs(target.current - pos.current) < 0.001 && Math.abs(vel.current) < 0.001)) {
        pos.current = target.current;
        vel.current = 0;
        paint();
        raf.current = 0;
        settle();
        rest();
        return;
      }
    }
    paint();
    if (Math.round(pos.current) !== shown.current) settle();
    raf.current = requestAnimationFrame(loop);
  }, [paint, settle, rest]);

  const kick = useCallback((): void => {
    if (!raf.current) raf.current = requestAnimationFrame(loop);
  }, [loop]);

  const moveTo = useCallback((i: number): void => {
    target.current = clamp(i);
    kick();
  }, [clamp, kick]);

  useEffect(() => {
    paint();
    return () => {
      cancelAnimationFrame(raf.current);
      // Leaving with "Continue" mid-dwell: the language in the middle is the one the reader chose.
      dwell.current?.flush();
    };
  }, [paint]);

  // A wheel listener must be non-passive to keep the page from scrolling.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let acc = 0;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) > 40) {
        moveTo(Math.round(target.current) + Math.sign(acc));
        acc = 0;
      }
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [moveTo]);

  const optionId = (i: number): string => `onboarding-language-${i}`;

  return (
    <div
      ref={rootRef}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={optionId(selected)}
      className={`timon-onboarding-roller relative cursor-grab select-none overflow-hidden rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing ${className ?? ''}`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveTo(Math.round(target.current) + 1); }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveTo(Math.round(target.current) - 1); }
        if (e.key === 'Enter') { e.preventDefault(); dwell.current?.flush(); onConfirm(); }
      }}
      onPointerDown={(e) => {
        if ((e.target as Element).closest('button')) return;
        drag.current = { y: e.clientY, p: pos.current, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
        kick();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = e.clientY - d.y;
        if (Math.abs(dy) > 3) d.moved = true;
        pos.current = clamp(d.p - dy / ROW);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) {
          const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-roller-index]');
          if (row) { moveTo(Number(row.dataset.rollerIndex)); return; }
        }
        target.current = clamp(Math.round(pos.current));
        kick();
      }}
    >
      <div aria-hidden className="absolute inset-x-0 top-1/2 -mt-[23px] h-[46px] rounded-xl bg-muted/80 backdrop-blur" />
      {languages.map((info, i) => (
        <div
          key={info.tag}
          id={optionId(i)}
          ref={(el) => { rows.current[i] = el; }}
          role="option"
          aria-selected={i === selected}
          lang={info.tag}
          dir={info.dir}
          data-roller-index={i}
          className="timon-onboarding-roller-item absolute inset-x-0 top-1/2 -mt-[22px] flex h-[44px] items-center justify-center gap-3 font-semibold"
        >
          <LanguageFlag tag={info.tag} />
          <span>{info.name}</span>
        </div>
      ))}
      <div className="absolute right-1.5 top-1/2 z-[2] flex -translate-y-1/2 flex-col gap-1.5">
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('onboarding.language.previous')}
          disabled={selected <= 0}
          onClick={() => moveTo(Math.round(target.current) - 1)}
          className="grid h-[22px] w-[26px] place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          <ChevronUp className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('onboarding.language.next')}
          disabled={selected >= last}
          onClick={() => moveTo(Math.round(target.current) + 1)}
          className="grid h-[22px] w-[26px] place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
