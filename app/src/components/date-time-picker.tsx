'use client';

/**
 * A date and time field drawn by the product: a trigger that reads the value,
 * and a month calendar with an hour field in the shared anchored popover. It
 * replaces the browser's own `datetime-local` popup, which looks different on
 * every OS and ignores the theme.
 *
 * The value keeps the `datetime-local` shape (`YYYY-MM-DDTHH:mm`, local time,
 * `''` for none), so a form that held a native input swaps it as is.
 */

import { useId, useMemo, useRef, useState } from 'react';
import { DayPicker, type ChevronProps } from 'react-day-picker';
import { de, enUS, es, fr, it, ja, ko, nl, pl, pt, ptBR, type Locale as CalendarLocale } from 'react-day-picker/locale';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { AnchoredPopover } from '@/components/anchored-popover';
import { getLocale, t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { cn } from '@/lib/utils';
import { DEFAULT_TIME, joinLocalValue, splitLocalValue } from '@/lib/date-time-value';

function Chevron({ orientation, className }: ChevronProps) {
  const Icon = orientation === 'left' ? ChevronLeft : ChevronRight;
  return <Icon className={cn('size-4', className)} aria-hidden />;
}

/**
 * The calendar's month and weekday names and first day of the week come from
 * its own locale objects, not from `Intl`: one per language the product ships
 * or plans to. A language without one gets the calendar of its primary
 * language (`pt-PT` → `pt`), else English.
 */
const CALENDAR_LOCALES: Readonly<Record<string, CalendarLocale>> = {
  en: enUS, de, es, fr, it, ja, ko, nl, pl, pt, 'pt-BR': ptBR,
};

export function calendarLocale(tag: string): CalendarLocale {
  return CALENDAR_LOCALES[tag] ?? CALENDAR_LOCALES[tag.split('-')[0] ?? ''] ?? enUS;
}

export function DateTimePicker({ id, value, onChange, placeholder, className, triggerClassName, disablePast = true }: {
  id?: string;
  /** `YYYY-MM-DDTHH:mm` in local time, `''` for none. */
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
  /** Overrides the trigger's fill, e.g. a white field on a tinted block. */
  triggerClassName?: string;
  /** Days before today cannot be picked (a start date in the past would fire at once). */
  disablePast?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const timeId = useId();
  const parts = splitLocalValue(value);
  const [month, setMonth] = useState<Date>(() => parts?.date ?? new Date());
  const lang = getLocale();
  const locale = calendarLocale(lang);
  const shown = useMemo(() => {
    if (!parts) return null;
    const [h, m] = parts.time.split(':').map(Number);
    const at = new Date(parts.date);
    at.setHours(h ?? 0, m ?? 0);
    return formatDateTime(at, { dateStyle: 'medium', timeStyle: 'short' }, lang);
  }, [parts, lang]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const toggle = () => {
    if (!open) setMonth(parts?.date ?? new Date());
    setOpen(!open);
  };

  return (
    <>
      <div className={cn('flex min-w-0 items-center gap-1', className)}>
        <button
          ref={anchor}
          id={id}
          type="button"
          data-date-time-picker=""
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggle}
          className={cn('flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg bg-muted/50 px-2.5 text-left text-[13px] transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', triggerClassName)}
        >
          <CalendarDays className="size-4 flex-none text-muted-foreground" aria-hidden />
          <span className={cn('min-w-0 flex-1 truncate tabular-nums', !shown && 'text-muted-foreground/70')}>{shown ?? placeholder}</span>
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label={t('dateTimePicker.clear')}
            title={t('dateTimePicker.clear')}
            className="grid size-8 flex-none place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      <AnchoredPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        align="start"
        width={288}
        maxHeight={420}
        label={placeholder}
        className="flex flex-col gap-3 p-3"
      >
        <DayPicker
          mode="single"
          locale={locale}
          month={month}
          onMonthChange={setMonth}
          selected={parts?.date}
          onSelect={(day) => { if (day) onChange(joinLocalValue(day, parts?.time ?? DEFAULT_TIME)); }}
          disabled={disablePast ? { before: today } : undefined}
          showOutsideDays
          components={{ Chevron }}
          classNames={{
            root: 'relative text-[13px]',
            months: 'flex flex-col',
            month: 'flex flex-col gap-2',
            month_caption: 'flex h-8 items-center px-1',
            caption_label: 'font-semibold capitalize text-foreground',
            nav: 'absolute right-0 top-0 flex items-center gap-0.5',
            button_previous: 'grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-40',
            button_next: 'grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-40',
            month_grid: 'w-full border-collapse',
            weekdays: 'flex',
            weekday: 'flex-1 pb-1 text-center text-[11px] font-medium uppercase text-muted-foreground',
            week: 'flex',
            day: 'flex-1 p-0.5 text-center',
            day_button: 'mx-auto grid size-8 place-items-center rounded-lg tabular-nums transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none',
            selected: '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary',
            today: '[&>button]:font-semibold [&>button]:text-primary',
            outside: 'text-muted-foreground/50',
            disabled: 'text-muted-foreground/40',
            hidden: 'invisible',
          }}
        />
        <div className="flex items-center gap-2">
          <label htmlFor={timeId} className="text-xs font-medium text-muted-foreground">{t('dateTimePicker.time')}</label>
          <input
            id={timeId}
            type="time"
            value={parts?.time ?? DEFAULT_TIME}
            disabled={!parts}
            onChange={(e) => { if (parts && e.target.value) onChange(joinLocalValue(parts.date, e.target.value)); }}
            // The time is typed in place: the browser's own clock popup stays hidden.
            className="h-8 rounded-lg bg-muted/50 px-2 text-[13px] tabular-nums text-foreground outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&::-webkit-calendar-picker-indicator]:hidden"
          />
          <button
            type="button"
            onClick={() => { setOpen(false); anchor.current?.focus(); }}
            className="ml-auto h-8 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('dateTimePicker.done')}
          </button>
        </div>
      </AnchoredPopover>
    </>
  );
}
