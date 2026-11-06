'use client';

import { cn } from '@/lib/utils';

type SegItem<V extends string> = { value: V; label: React.ReactNode };

type SegControlProps<V extends string> = {
  items: ReadonlyArray<SegItem<V>>;
  value: V;
  onChange: (v: V) => void;
  className?: string;
};

export function SegControl<V extends string>({
  items,
  value,
  onChange,
  className,
}: SegControlProps<V>) {
  return (
    <div
      className={cn(
        'inline-flex gap-0.5 rounded-md border border-border bg-background/60 p-0.5',
        className,
      )}
    >
      {items.map((it) => {
        const on = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            onClick={() => onChange(it.value)}
            className={cn(
              'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
              on
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
