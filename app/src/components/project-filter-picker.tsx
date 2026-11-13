'use client';

/**
 * Compact project filter — designed trigger + menu (no native <select>).
 */
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export type ProjectFilterOption = { value: string; label: string };

export function ProjectFilterPicker({
  value,
  options,
  onChange,
  label,
  className,
  triggerClassName,
}: {
  value: string;
  options: readonly ProjectFilterOption[];
  onChange: (value: string) => void;
  label: string;
  className?: string;
  triggerClassName?: string;
}) {
  const current = options.find((o) => o.value === value)?.label ?? options[0]?.label ?? '';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12px] text-foreground outline-none transition-colors',
            'hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring',
            triggerClassName,
          )}
        >
          <span className="min-w-0 truncate">{current}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn('min-w-[10rem]', className)}>
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            data-selected={o.value === value || undefined}
            onSelect={() => onChange(o.value)}
            className={cn(o.value === value && 'bg-muted')}
          >
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
