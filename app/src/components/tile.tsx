import { cn } from '@/lib/utils';

type TileProps = Omit<React.HTMLAttributes<HTMLElement>, 'title'> & {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  bodyClassName?: string;
};

export function Tile({
  title,
  subtitle,
  actions,
  className,
  bodyClassName,
  children,
  ...rest
}: TileProps) {
  return (
    <section
      {...rest}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card',
        className,
      )}
    >
      {(title || subtitle || actions) && (
        <header className="flex min-h-10 shrink-0 items-center gap-2 px-3 pb-1 pt-2">
          {title && (
            <span className="min-w-0 truncate text-xs font-medium text-foreground">
              {title}
            </span>
          )}
          {subtitle && (
            <span className="text-[11.5px] font-medium tabular-nums text-muted-foreground">
              {subtitle}
            </span>
          )}
          {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn('scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto p-4', bodyClassName)}>
        {children}
      </div>
    </section>
  );
}
