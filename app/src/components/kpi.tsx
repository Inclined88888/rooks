import { cn } from '@/lib/utils';

type KpiProps = {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  delta?: React.ReactNode;
  bad?: boolean;
  accent?: boolean;
  className?: string;
};

export function Kpi({ label, value, unit, delta, bad, accent, className }: KpiProps) {
  return (
    <div
      className={cn(
        'relative flex flex-col justify-between gap-2 overflow-hidden rounded-xl border border-border bg-card p-3.5',
        accent &&
          'border-primary/30 bg-gradient-to-b from-primary/10 to-primary/[0.02]',
        className,
      )}
    >
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'flex items-baseline gap-1.5 tabular-nums text-[30px] font-semibold leading-none -tracking-[0.01em]',
          accent ? 'text-primary' : 'text-foreground',
        )}
      >
        {value}
        {unit && (
          <span className="font-sans text-xs font-medium text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
      {delta && (
        <div
          className={cn(
            'mt-1 inline-flex items-center gap-1 tabular-nums text-[11.5px] font-medium',
            bad ? 'text-destructive' : 'text-[hsl(var(--success))]',
          )}
        >
          {delta}
        </div>
      )}
    </div>
  );
}
